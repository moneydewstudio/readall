import React, { useEffect, useRef } from 'react';
import { useReadallStore } from './store/useReadallStore';
import { Library } from './components/Library';
import { Reader } from './components/Reader';
import { Settings } from './components/Settings';
import { semanticChunkText } from './services/aiService';
import { saveBookToDB } from './services/db';

const App: React.FC = () => {
  const { currentView, activeBook, settings, loadBook } = useReadallStore();
  
  // Ref to track if we are currently processing to avoid race conditions
  const processingRef = useRef(false);

  // Effect: Background AI Chunking (Simulated Worker logic for single-file constraint)
  useEffect(() => {
    const processAIChunks = async () => {
        if (!activeBook || settings.chunkingMode !== 'ai' || !settings.apiKey || processingRef.current) return;
        
        // Check if already chunked by AI (look for 'phrase' kind)
        const hasSmartChunks = activeBook.chunks.some(c => c.kind === 'phrase' || c.kind === 'idiom');
        if (hasSmartChunks) return;

        processingRef.current = true;
        console.log("Starting background AI chunking...");

        try {
            // Chunk a small segment around current index or start
            // Limit to 2500 chars for demo purposes to save tokens but cover enough ground
            const LIMIT = 2500;
            const textSegment = activeBook.content.slice(0, LIMIT); 
            
            const smartChunks = await semanticChunkText(textSegment, settings.apiKey);
            
            if (smartChunks.length > 0) {
                console.log("AI Chunking complete, merging chunks...");
                
                // Determine the boundary where smart chunks end
                const lastSmartChunk = smartChunks[smartChunks.length - 1];
                const boundaryEndIndex = lastSmartChunk.end;

                // Filter existing chunks to keep only those that start AFTER the smart chunks end
                // This preserves the rest of the book that wasn't processed by AI
                const remainingChunks = activeBook.chunks.filter(c => c.start >= boundaryEndIndex);

                const mergedChunks = [...smartChunks, ...remainingChunks];

                const updatedBook = {
                    ...activeBook,
                    chunks: mergedChunks
                };
                
                await saveBookToDB(updatedBook);
                
                // Only update store if we are still looking at this book to avoid view jumps
                if (useReadallStore.getState().activeBookId === activeBook.id) {
                    loadBook(updatedBook);
                }
            }
        } catch (error) {
            console.error("Critical error during AI chunking:", error);
        } finally {
            processingRef.current = false;
        }
    };

    // Debounce slightly to allow load
    const timer = setTimeout(processAIChunks, 2000);
    return () => clearTimeout(timer);
  }, [activeBook?.id, settings.chunkingMode, settings.apiKey, activeBook?.content, loadBook]);

  return (
    <div className="min-h-screen w-full bg-gray-900 text-white font-sans selection:bg-red-500 selection:text-white">
      {currentView === 'library' && <Library />}
      {currentView === 'reader' && <Reader />}
      {currentView === 'settings' && <Settings />}
    </div>
  );
};

export default App;