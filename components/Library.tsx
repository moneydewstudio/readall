import React, { useEffect, useState } from 'react';
import { useReadallStore } from '../store/useReadallStore';
import { algorithmicChunker, extractChapters } from '../services/rsvpUtils';
import { saveBookToDB, getBooksFromDB, deleteBookFromDB } from '../services/db.ts';
import { generatePrimingSummary } from '../services/aiService';
import { Book, Chunk, Chapter } from '../types';

// Declare global types for external libraries loaded via CDN
declare global {
  interface Window {
    pdfjsLib: any;
    ePub: any; // ePub.js
    JSZip: any;
  }
}

interface ExtractionResult {
  text: string;
  meta: {
    title?: string;
    author?: string;
    publisher?: string;
    publishedDate?: string;
  };
  toc?: Array<{ title: string; offset: number }>;
}

export const Library: React.FC = () => {
  const { loadBook, setBooks, books, settings, setView, removeBook } = useReadallStore();
  const [isProcessing, setIsProcessing] = useState(false);
  
  // State for Priming Modal
  const [primingBook, setPrimingBook] = useState<Book | null>(null);

  useEffect(() => {
    // Hydrate books from IndexedDB on mount
    getBooksFromDB().then((storedBooks) => {
      // Safety check to ensure storedBooks is an array before setting
      setBooks(Array.isArray(storedBooks) ? storedBooks : []);
    });
  }, [setBooks]);

  const extractTextFromPDF = async (arrayBuffer: ArrayBuffer): Promise<ExtractionResult> => {
    if (!window.pdfjsLib) throw new Error("PDF.js library not loaded");
    
    // Robustly ensure worker is set
    if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
    
    let pdf;
    try {
        pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    } catch (e) {
        throw new Error("Failed to parse PDF document structure.");
    }
    
    // Extract Metadata
    let meta: ExtractionResult['meta'] = {};
    try {
        const metadataResult = await pdf.getMetadata();
        if (metadataResult?.info) {
            meta = {
                title: metadataResult.info.Title,
                author: metadataResult.info.Author,
            };
        }
    } catch (e) {
        console.warn("Could not extract PDF metadata", e);
    }

    let fullText = "";

    // Iterate over all pages
    for (let i = 1; i <= pdf.numPages; i++) {
      try {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          
          if (textContent.items) {
             const pageStrings = textContent.items.map((item: any) => item.str).join(' ');
             fullText += pageStrings + "\n\n";
          }
      } catch (e) {
          console.warn(`Skipping PDF page ${i} due to extraction error`, e);
      }
    }

    return { text: fullText, meta };
  };

  const extractTextFromEPUB = async (arrayBuffer: ArrayBuffer): Promise<ExtractionResult> => {
    if (!window.ePub) throw new Error("ePub.js library not loaded. Please refresh.");
    if (!window.JSZip) console.warn("JSZip not found (required for EPUB).");

    // Initialize Book
    const book = window.ePub(arrayBuffer);
    
    // Wait for parsing
    await book.ready;
    
    // Metadata
    let meta: ExtractionResult['meta'] = {};
    try {
        const metadata = await book.loaded.metadata;
        meta = {
            title: metadata.title,
            author: metadata.creator,
            publisher: metadata.publisher,
            publishedDate: metadata.pubdate
        };
    } catch (e) {
        console.warn("EPUB Metadata error", e);
    }
    
    let fullText = "";
    const spine = book.spine;
    const spineOffsets: number[] = [];
    
    if (!spine || !spine.spineItems || spine.spineItems.length === 0) {
         throw new Error("EPUB structure is empty or encrypted (DRM protected).");
    }

    // book.spine.spineItems contains the linear reading order of the book
    // Iterate to build fullText and track start offsets of each file
    for (const item of spine.spineItems) {
      // Record the start index of this section in the full text
      spineOffsets.push(fullText.length);
      
      try {
        // .load returns a Promise resolving to the document/string
        // We bind book.load to ensure internal resource resolution works
        const doc = await item.load(book.load.bind(book));
        
        let sectionText = "";

        if (doc) {
            if (typeof doc === 'string') {
                // Raw HTML/XHTML string
                const parser = new DOMParser();
                // Use text/html to be safe, or application/xhtml+xml
                const parsed = parser.parseFromString(doc, "text/html");
                // Access body or documentElement
                const el = parsed.body || parsed.documentElement;
                if (el) sectionText = el.textContent || "";
            } else if (doc instanceof Document) {
                // DOM Document (XML or HTML)
                const el = doc.body || doc.documentElement;
                if (el) sectionText = el.textContent || "";
            } else if (typeof doc === 'object') {
                 // Fallback for weird object wrapper
                 if ('innerText' in doc) sectionText = doc['innerText'];
                 else if ('textContent' in doc) sectionText = doc['textContent'];
                 else if (doc.body && 'textContent' in doc.body) sectionText = doc.body.textContent;
            }
        }
        
        // Normalize whitespace: collapse multiple spaces/newlines to single space
        sectionText = sectionText.replace(/\s+/g, ' ').trim();

        if (sectionText.length > 0) {
           fullText += sectionText + "\n\n";
        }
        
        // Memory cleanup
        if (item.unload && typeof item.unload === 'function') {
            item.unload();
        }
      } catch (e) {
        console.warn(`Failed to extract text from EPUB section ${item.href}`, e);
      }
    }
    
    if (!fullText.trim()) {
        console.warn("EPUB Extraction failed: No text found in any spine item.");
        throw new Error("No readable text found. Book might be image-based or DRM protected.");
    }

    // Extract Table of Contents
    const toc: Array<{ title: string; offset: number }> = [];
    
    try {
        // Helper to recursively process navigation items
        const processNavItems = (items: any[]) => {
            items.forEach(item => {
                if (item.href) {
                    // Remove hash from href to find the file in spine (e.g. chapter.html#id -> chapter.html)
                    // Note: We map to the start of the file/spine item, not the specific anchor, 
                    // because we lost internal anchor offsets during plain text extraction.
                    const cleanHref = item.href.split('#')[0];
                    const spineItem = book.spine.get(cleanHref);
                    
                    if (spineItem) {
                        // spineItem.index corresponds to the order in spine.spineItems
                        // We use the recorded start offset for that file from our extraction loop
                        const offset = spineOffsets[spineItem.index];
                        if (offset !== undefined) {
                            toc.push({
                                title: item.label ? item.label.trim() : "Untitled",
                                offset: offset
                            });
                        }
                    }
                }
                if (item.subitems && item.subitems.length > 0) {
                    processNavItems(item.subitems);
                }
            });
        };

        if (book.navigation && book.navigation.toc) {
            processNavItems(book.navigation.toc);
        }
    } catch (e) {
        console.warn("Failed to extract EPUB TOC", e);
    }

    return { text: fullText, meta, toc };
  };

  /**
   * Scans text for Chapter 1 / Prologue headers to skip table of contents/front matter.
   */
  const detectStartChapterIndex = (text: string, chunks: Chunk[]): number => {
    // Regex patterns to find standard starting points
    // Priorities: Chapter 1/One/I -> Prologue -> Introduction
    const patterns = [
      /(?:^|\n)\s*(?:chapter|part)\s+(?:one|1|i)(?:\s+|$|[.:-])/i,
      /(?:^|\n)\s*prologue(?:\s+|$|[.:-])/i,
      /(?:^|\n)\s*introduction(?:\s+|$|[.:-])/i
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match.index !== undefined) {
        // Find chunks closest to this position
        // match.index is the character index in full text.
        // We find the first chunk that starts at or after this index.
        const foundChunkIndex = chunks.findIndex(c => c.start >= match.index!);
        if (foundChunkIndex !== -1) {
            console.log(`[Smart Start] Found starting point at chunk ${foundChunkIndex} (pattern: ${pattern})`);
            return foundChunkIndex;
        }
      }
    }
    return 0;
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);

    try {
      let text = "";
      let metadata: ExtractionResult['meta'] = {};
      let epubToc: ExtractionResult['toc'] | undefined;
      let fileType: 'text' | 'epub' | 'pdf' = 'text';

      const fileName = file.name.toLowerCase();

      if (file.type === 'application/pdf' || fileName.endsWith('.pdf')) {
        fileType = 'pdf';
        const buffer = await file.arrayBuffer();
        const result = await extractTextFromPDF(buffer);
        text = result.text;
        metadata = result.meta;
      } else if (file.type === 'application/epub+zip' || fileName.endsWith('.epub')) {
        fileType = 'epub';
        const buffer = await file.arrayBuffer();
        const result = await extractTextFromEPUB(buffer);
        text = result.text;
        metadata = result.meta;
        epubToc = result.toc;
      } else {
        // Fallback for .txt, .md
        text = await file.text();
      }
      
      if (!text || !text.trim()) {
          throw new Error("No text content extracted. The file might be empty, password protected, or contain only images.");
      }

      // Initial algorithmic chunking (instant)
      const initialChunks = algorithmicChunker(text);

      // Attempt to auto-detect Chapter 1 for progress start
      const startProgressIndex = detectStartChapterIndex(text, initialChunks);
      
      // Generate Chapter List (Prioritize EPUB TOC, fallback to Regex)
      let chapters: Chapter[] = [];
      if (epubToc && epubToc.length > 0) {
        // Map character offsets to chunk indices
        chapters = epubToc.map(item => {
             // Find first chunk that starts after or at the offset
             const index = initialChunks.findIndex(c => c.start >= item.offset);
             return {
                 title: item.title,
                 chunkIndex: index === -1 ? 0 : index
             };
        }).sort((a, b) => a.chunkIndex - b.chunkIndex);

        // Deduplicate chunks (some TOC items might point to same page/start)
        chapters = chapters.filter((item, pos, ary) => {
            return !pos || item.chunkIndex !== ary[pos - 1].chunkIndex;
        });
      }

      if (chapters.length === 0) {
         chapters = extractChapters(text, initialChunks);
      }

      // Determine Book Title: Metadata > Filename
      let bookTitle = file.name.replace(/\.[^/.]+$/, ""); // Default to filename
      if (metadata.title && metadata.title.trim().length > 0) {
        bookTitle = metadata.title.trim();
      }

      const newBook: Book = {
        id: crypto.randomUUID(),
        title: bookTitle,
        content: text,
        chunks: initialChunks,
        chapters: chapters,
        progressIndex: startProgressIndex, // Defaults to Chapter 1 location if found
        createdAt: Date.now(),
        metadata: {
            fileType: fileType,
            author: metadata.author,
            publisher: metadata.publisher,
            publishedDate: metadata.publishedDate
        }
      };

      // Save initial state immediately so user sees the book
      await saveBookToDB(newBook);
      setBooks([...books, newBook]);
      setIsProcessing(false);

      // --- Background AI Priming ---
      // Check for API Key and sufficient text length
      if (settings.apiKey && text.length > 500) {
        const startChar = initialChunks[startProgressIndex]?.start || 0;
        const relevantText = text.slice(startChar);
        const primingText = relevantText.split(/\s+/).slice(0, 2000).join(' ');
        
        console.log(`[Priming] Generating summary for ${newBook.title}...`);
        
        generatePrimingSummary(primingText, settings.apiKey).then(async (summary) => {
          if (summary) {
            console.log(`[Priming] Summary generated for ${newBook.title}`);
            const updatedBook = { ...newBook, primingSummary: summary };
            await saveBookToDB(updatedBook);
            setBooks(prevBooks => 
               prevBooks.map(b => b.id === updatedBook.id ? updatedBook : b)
            );
          }
        });
      }

    } catch (e: any) {
      console.error("Failed to load file", e);
      alert(`Error reading file: ${e.message || "Unknown error"}`);
      setIsProcessing(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if(confirm("Delete this book?")) {
        // Optimistic UI Update: Remove immediately from state
        removeBook(id);
        // Background DB deletion
        try {
          await deleteBookFromDB(id);
        } catch (err) {
          console.error("Failed to delete from DB", err);
          // If needed we could reload here, but for now we assume success
        }
    }
  }

  const handleBookClick = (book: Book) => {
    if (book.primingSummary && book.primingSummary.length > 0) {
      setPrimingBook(book);
    } else {
      loadBook(book);
    }
  };

  return (
    <div className="p-8 max-w-4xl mx-auto text-gray-100">
      <header className="mb-12 flex justify-between items-center border-b border-gray-800 pb-6">
        <div>
            <h1 className="text-4xl font-bold font-serif tracking-tight mb-2">Readall</h1>
            <p className="text-gray-400">High-performance RSVP Reader</p>
        </div>
        
        <div className="flex items-center gap-4">
            <button 
                onClick={() => setView('settings')}
                className="text-gray-400 hover:text-white p-2 rounded-full hover:bg-gray-800 transition"
                title="Settings"
                aria-label="Open Settings"
            >
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.47a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.39a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>

            <label className={`
                cursor-pointer bg-blue-600 hover:bg-blue-500 text-white px-6 py-3 rounded-lg font-medium transition
                ${isProcessing ? 'opacity-50 pointer-events-none' : ''}
            `}>
                {isProcessing ? 'Processing...' : 'Import Book'}
                <input type="file" accept=".txt,.md,.pdf,.epub" className="hidden" onChange={handleFileUpload} />
            </label>
        </div>
      </header>

      {books.length === 0 ? (
        <div className="text-center py-20 bg-gray-800/50 rounded-xl border border-gray-800 border-dashed">
            <p className="text-gray-500 text-xl">Library is empty. Import a Book (PDF/EPUB/TXT) to begin.</p>
            {!settings.apiKey && (
              <p className="text-sm text-yellow-500 mt-2">Add your OpenRouter API Key in settings to enable AI Priming.</p>
            )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {books.map((book) => (
            <div 
              key={book.id}
              onClick={() => handleBookClick(book)}
              className="group bg-gray-800 hover:bg-gray-700 transition p-6 rounded-xl cursor-pointer border border-gray-700 hover:border-blue-500/50 relative overflow-hidden"
            >
              <h3 className="text-xl font-bold mb-1 truncate text-gray-100 group-hover:text-blue-400">{book.title}</h3>
              {book.metadata?.author && (
                  <p className="text-sm text-gray-400 mb-3 italic">by {book.metadata.author}</p>
              )}
              <div className="flex justify-between items-end text-sm text-gray-500 mt-4">
                 <div className="flex gap-2">
                    <span className="bg-gray-900 px-2 py-0.5 rounded text-xs uppercase text-gray-400">{book.metadata?.fileType || 'TEXT'}</span>
                    <span>{book.chunks.length} words</span>
                 </div>
                 <span>{(Math.min(book.progressIndex / book.chunks.length, 1) * 100).toFixed(0)}% Complete</span>
              </div>
              
              {/* Badge if Primed */}
              {book.primingSummary && (
                <div className="absolute top-0 left-0 bg-blue-600/20 text-blue-400 text-[10px] px-2 py-1 font-mono uppercase tracking-widest backdrop-blur-sm">
                  AI Primed
                </div>
              )}
              
              <button 
                onClick={(e) => handleDelete(e, book.id)}
                className="absolute top-4 right-4 text-gray-600 hover:text-red-400 p-2 z-20 transition-colors"
                title="Delete"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Priming Modal */}
      {primingBook && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl max-w-lg w-full shadow-2xl flex flex-col max-h-[85vh]">
            <div className="p-6 border-b border-gray-800 bg-gray-800/50 shrink-0">
              <h2 className="text-2xl font-serif font-bold text-white">{primingBook.title}</h2>
              <p className="text-blue-400 text-sm font-medium mt-1 uppercase tracking-wider">Chapter Priming Brief</p>
            </div>
            
            <div className="p-6 space-y-4 overflow-y-auto">
              <p className="text-gray-400 text-sm italic mb-4">
                Before you begin, here are the key themes and concepts extracted from the opening text:
              </p>
              <ul className="space-y-3">
                {primingBook.primingSummary?.map((point, i) => (
                  <li key={i} className="flex gap-3 text-gray-200 leading-relaxed">
                    <span className="text-blue-500 font-bold mt-0.5">•</span>
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="p-6 border-t border-gray-800 bg-gray-800/30 flex justify-end gap-3 shrink-0">
              <button 
                onClick={() => setPrimingBook(null)}
                className="px-4 py-2 text-gray-400 hover:text-white transition"
              >
                Close
              </button>
              <button 
                onClick={() => {
                  loadBook(primingBook);
                  setPrimingBook(null);
                }}
                className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold shadow-lg shadow-blue-500/20 transition-all hover:scale-105"
              >
                Start Reading
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};