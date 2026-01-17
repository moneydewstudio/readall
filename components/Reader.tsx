import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useReadallStore } from '../store/useReadallStore';
import { calculateChunkDelay, calculateFocalIndex } from '../services/rsvpUtils';
import { saveBookToDB } from '../services/db';
import { Chunk } from '../types';

export const Reader: React.FC = () => {
  const { 
    activeBook, 
    currentIndex, 
    setCurrentIndex, 
    isPlaying, 
    setIsPlaying, 
    settings,
    setView,
    updateSettings,
    updateBookProgress
  } = useReadallStore();

  const requestRef = useRef<number>();
  const lastTimeRef = useRef<number>();
  const chunkRef = useRef<Chunk | null>(null);
  
  // Performance Optimization: Cache & Refs
  // We use refs to look ahead and store calculations to avoid per-frame jitter.
  const preparedCacheRef = useRef<Map<number, { focalIndex: number, delay: number }>>(new Map());
  // We track chunks reference to invalidate cache if the chunks array is replaced (e.g. by AI enhancement)
  const cacheSettingsRef = useRef({ wpm: settings.wpm, bookId: activeBook?.id, chunksRef: activeBook?.chunks });
  const currentIndexRef = useRef(currentIndex);

  // Gesture State
  // Opacity is controlled via this state to achieve the requested 50% fade
  const [feedback, setFeedback] = useState<{ text: string, opacity: number }>({ text: '', opacity: 0 });
  const [showChapters, setShowChapters] = useState(false);

  const touchRef = useRef({
    startX: 0,
    startY: 0,
    startTime: 0,
    lastTapTime: 0,
    initialWpm: settings.wpm,
    isSwiping: false
  });

  // Sync index ref for animation loop access
  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);

  // Derived state for the current chunk
  const currentChunk = activeBook?.chunks[currentIndex];
  
  // Update ref for loop access without closure staleness
  useEffect(() => {
    chunkRef.current = currentChunk || null;
  }, [currentChunk]);

  /**
   * Save Session Progress to DB and Store
   */
  const saveSession = useCallback(() => {
    if (activeBook && currentIndexRef.current !== activeBook.progressIndex) {
        const current = currentIndexRef.current;
        const updatedBook = { ...activeBook, progressIndex: current };
        
        // Fire and forget DB save
        saveBookToDB(updatedBook).catch(err => console.error("Failed to save progress", err));
        
        // Sync store so library view is updated
        updateBookProgress(activeBook.id, current);
    }
  }, [activeBook, updateBookProgress]);

  // Save on Unmount
  useEffect(() => {
    return () => saveSession();
  }, [saveSession]);

  // Save when pausing (good checkpoint)
  useEffect(() => {
    if (!isPlaying) {
        saveSession();
    }
  }, [isPlaying, saveSession]);

  // Screen Wake Lock to prevent sleep while reading
  useEffect(() => {
    let wakeLock: any = null;

    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          wakeLock = await (navigator as any).wakeLock.request('screen');
        }
      } catch (err) {
        console.debug('Wake Lock ignored:', err);
      }
    };

    // Request on mount
    requestWakeLock();

    // Re-acquire lock if visibility changes (e.g. user switches tabs/apps and comes back)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (wakeLock) {
        wakeLock.release().catch(() => {});
      }
    };
  }, []);

  // Cache Management: Invalidate if settings OR content changes
  if (
      cacheSettingsRef.current.wpm !== settings.wpm || 
      cacheSettingsRef.current.bookId !== activeBook?.id ||
      cacheSettingsRef.current.chunksRef !== activeBook?.chunks
  ) {
    preparedCacheRef.current.clear();
    cacheSettingsRef.current = { wpm: settings.wpm, bookId: activeBook?.id, chunksRef: activeBook?.chunks };
  }

  // Background Pre-calculation Effect
  useEffect(() => {
    if (!activeBook) return;
    
    const PRELOAD_WINDOW = 50; // Look ahead 50 chunks
    
    for (let i = 0; i < PRELOAD_WINDOW; i++) {
        const targetIndex = currentIndex + i;
        if (targetIndex >= activeBook.chunks.length) break;
        
        // Only calculate if not already in cache
        if (!preparedCacheRef.current.has(targetIndex)) {
            const chunk = activeBook.chunks[targetIndex];
            
            // 1. Calculate Focal Index (ORP)
            const focalIndex = chunk.focalIndex ?? calculateFocalIndex(chunk.text);
            
            // 2. Calculate Delay (Timing)
            const delay = calculateChunkDelay(chunk, settings.wpm);
            
            preparedCacheRef.current.set(targetIndex, { focalIndex, delay });
        }
    }
  }, [currentIndex, settings.wpm, activeBook]);

  /**
   * High-Precision Animation Loop
   * Using requestAnimationFrame for visual sync, but tracking time delta for pacing.
   */
  const animate = useCallback((time: number) => {
    if (lastTimeRef.current === undefined) {
      lastTimeRef.current = time;
    }

    const deltaTime = time - lastTimeRef.current;
    
    // Safety check
    if (!chunkRef.current) {
         setIsPlaying(false);
         return;
    }

    // Determine delay: Prefer cache, fallback to live calculation
    let delay: number;
    const currentIdx = currentIndexRef.current;
    const cached = preparedCacheRef.current.get(currentIdx);
    
    if (cached) {
        delay = cached.delay;
    } else {
        delay = calculateChunkDelay(chunkRef.current, settings.wpm);
    }

    if (deltaTime >= delay) {
      // Advance word
      useReadallStore.getState().advanceIndex();
      lastTimeRef.current = time; // Reset timer
    }

    if (useReadallStore.getState().isPlaying) {
      requestRef.current = requestAnimationFrame(animate);
    }
  }, [settings.wpm, setIsPlaying]);

  // Handle Play/Pause Toggle
  useEffect(() => {
    if (isPlaying) {
      lastTimeRef.current = undefined; // Reset timing on start
      requestRef.current = requestAnimationFrame(animate);
    } else {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    }
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [isPlaying, animate]);

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;

      if (e.code === 'Space') {
        e.preventDefault();
        setIsPlaying(!isPlaying);
      } else if (e.code === 'ArrowLeft') {
        useReadallStore.getState().rewindIndex(10);
      } else if (e.code === 'ArrowRight') {
        useReadallStore.getState().setCurrentIndex(currentIndex + 10);
      } else if (e.code === 'Escape') {
        if (showChapters) {
            setShowChapters(false);
        } else {
            saveSession();
            setIsPlaying(false);
            setView('library');
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, setIsPlaying, setView, currentIndex, showChapters, saveSession]);

  // --- Gesture Handlers ---

  const handleTouchStart = (e: React.TouchEvent) => {
    touchRef.current.startX = e.touches[0].clientX;
    touchRef.current.startY = e.touches[0].clientY;
    touchRef.current.startTime = Date.now();
    touchRef.current.initialWpm = settings.wpm;
    touchRef.current.isSwiping = false;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const currentY = e.touches[0].clientY;
    const deltaY = touchRef.current.startY - currentY; // Drag Up = Positive
    
    // Threshold to detect intentional swipe vs accidental jitter
    if (Math.abs(deltaY) > 20) {
       touchRef.current.isSwiping = true;
       // Gentle swipe sensitivity: 1px = ~0.8 WPM
       const change = Math.round(deltaY * 0.8);
       const newWpm = Math.max(50, Math.min(1200, touchRef.current.initialWpm + change));
       
       if (newWpm !== settings.wpm) {
         updateSettings({ wpm: newWpm });
         // Feedback at 50% opacity
         setFeedback({ text: `${newWpm} WPM`, opacity: 0.5 });
       }
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const time = Date.now();
    
    // If we were swiping, end the interaction and fade out feedback
    if (touchRef.current.isSwiping) {
        setTimeout(() => setFeedback(prev => ({ ...prev, opacity: 0 })), 1000);
        return;
    }

    // Tap Logic
    const duration = time - touchRef.current.startTime;
    const currentX = e.changedTouches[0].clientX;
    const deltaX = Math.abs(currentX - touchRef.current.startX);

    // Only consider it a tap if it was short and didn't move much
    if (duration < 300 && deltaX < 10) {
        const timeSinceLastTap = time - touchRef.current.lastTapTime;
        
        if (timeSinceLastTap < 350) {
            // --- Double Tap Detected ---
            const width = window.innerWidth;
            if (touchRef.current.startX < width / 2) {
                // Left Side: Rewind
                useReadallStore.getState().rewindIndex(10);
                setFeedback({ text: '« 10 Words', opacity: 0.5 });
            } else {
                // Right Side: Advance
                const current = useReadallStore.getState().currentIndex;
                useReadallStore.getState().setCurrentIndex(current + 10);
                setFeedback({ text: '10 Words »', opacity: 0.5 });
            }
            // Reset feedback after short delay
            setTimeout(() => setFeedback(prev => ({ ...prev, opacity: 0 })), 800);
            touchRef.current.lastTapTime = 0; 
        } else {
            // --- Single Tap ---
            // Register this tap time to check against the next one
            touchRef.current.lastTapTime = time;
        }
    }
  };

  if (!activeBook || !currentChunk) return <div>Loading...</div>;

  // Visual Setup
  const themeClasses = {
    oled: 'bg-black text-gray-300',
    sepia: 'bg-[#f4ecd8] text-[#5b4636]',
    'high-contrast': 'bg-white text-black font-bold'
  };

  const fontClasses = {
    sans: 'font-sans',
    serif: 'font-serif',
    mono: 'font-mono',
    opendyslexic: 'font-opendyslexic',
    lexend: 'font-lexend',
  };

  const sizeClasses = {
    sm: 'text-3xl md:text-5xl',
    md: 'text-4xl md:text-6xl',
    lg: 'text-5xl md:text-7xl',
    xl: 'text-6xl md:text-8xl'
  };

  // Font Control Handlers
  const cycleFontFamily = () => {
    const fonts: ('sans' | 'serif' | 'mono' | 'opendyslexic' | 'lexend')[] = ['sans', 'serif', 'mono', 'opendyslexic', 'lexend'];
    const nextIdx = (fonts.indexOf(settings.fontFamily) + 1) % fonts.length;
    updateSettings({ fontFamily: fonts[nextIdx] });
  };

  const cycleFontSize = () => {
    const sizes: ('sm' | 'md' | 'lg' | 'xl')[] = ['sm', 'md', 'lg', 'xl'];
    const nextIdx = (sizes.indexOf(settings.fontSize) + 1) % sizes.length;
    updateSettings({ fontSize: sizes[nextIdx] });
  };

  // Rendering Prep: Use cache if available for stable focal point
  const token = currentChunk.text;
  const cachedRender = preparedCacheRef.current.get(currentIndex);
  const focalIndex = cachedRender?.focalIndex ?? currentChunk.focalIndex ?? calculateFocalIndex(token);
  
  const leftPart = token.slice(0, focalIndex);
  const focalChar = token[focalIndex];
  const rightPart = token.slice(focalIndex + 1);

  return (
    <div 
        className={`fixed inset-0 flex flex-col items-center justify-center select-none ${themeClasses[settings.theme]} ${fontClasses[settings.fontFamily]}`}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
    >
      
      {/* Feedback Overlay - Positioned above Reticle (approx 35% from top) */}
      <div 
        className="absolute top-[35%] left-1/2 -translate-x-1/2 z-40 pointer-events-none bg-black text-white px-6 py-2 rounded-full text-lg font-bold tracking-widest shadow-2xl transition-opacity duration-300"
        style={{ opacity: feedback.opacity }}
      >
        {feedback.text}
      </div>

      {/* Top Bar (Zen Mode) */}
      <div className="absolute top-0 w-full p-4 flex justify-between items-center opacity-40 hover:opacity-100 transition-opacity z-20 bg-gradient-to-b from-black/50 to-transparent">
        <div className="flex items-center gap-4">
            <button onClick={() => { saveSession(); setView('library'); }} className="p-2 hover:text-red-500 font-bold">
            &larr;
            </button>
            <div className="flex items-center gap-2 bg-gray-800/50 rounded-lg p-1 text-sm backdrop-blur-sm">
                <button 
                    onClick={cycleFontFamily}
                    className="px-3 py-1 hover:bg-gray-700/80 rounded uppercase text-xs tracking-wider"
                    title="Change Font Family"
                >
                    {settings.fontFamily.replace('opendyslexic', 'Dyslexic').replace('lexend', 'Lexend')}
                </button>
                <div className="w-px h-4 bg-gray-600"></div>
                <button 
                    onClick={cycleFontSize}
                    className="px-3 py-1 hover:bg-gray-700/80 rounded font-bold"
                    title="Change Font Size"
                >
                    A{(settings.fontSize === 'xl') ? '+' : ''}
                </button>
            </div>
            {/* Chapters Toggle */}
            <button 
                onClick={(e) => { e.stopPropagation(); setShowChapters(!showChapters); setIsPlaying(false); }}
                className="p-2 hover:bg-gray-700 rounded-full"
                title="Chapters"
            >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            </button>
        </div>
        
        <div className="text-sm font-mono opacity-70">
           {settings.wpm} WPM
        </div>
        
        <button onClick={() => setView('settings')} className="p-2 hover:text-blue-500">
           Settings
        </button>
      </div>

      {/* Reader Cockpit */}
      <div className="relative w-full max-w-6xl h-80 flex items-center justify-center overflow-hidden">
        
        {/* Reticle Lines */}
        {settings.showReticle && (
          <>
            <div className="absolute top-0 bottom-[60%] left-1/2 -translate-x-1/2 w-0.5 bg-current opacity-20"></div>
            <div className="absolute top-[60%] bottom-0 left-1/2 -translate-x-1/2 w-0.5 bg-current opacity-20"></div>
            <div className="absolute left-[20%] right-[20%] top-[30%] bottom-[30%] border-t border-b border-current opacity-5 pointer-events-none"></div>
          </>
        )}

        {/* Word Display */}
        <div 
            className={`absolute left-1/2 flex items-baseline whitespace-pre leading-none ${sizeClasses[settings.fontSize]}`}
            style={{ transform: 'translateX(-50%)' }} 
        >
             <div className="flex items-baseline">
                <span className="text-right w-[40vw] flex justify-end">{leftPart}</span>
                <span className="text-red-500 font-bold text-center shrink-0">{focalChar}</span>
                <span className="text-left w-[40vw] flex justify-start">{rightPart}</span>
             </div>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="absolute bottom-10 w-full max-w-2xl px-8 opacity-40 hover:opacity-100 transition-opacity z-20">
        <input 
            type="range" 
            min="0" 
            max={activeBook.chunks.length - 1} 
            value={currentIndex}
            onChange={(e) => {
                setIsPlaying(false);
                setCurrentIndex(Number(e.target.value));
            }}
            className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-red-500"
            onTouchStart={(e) => e.stopPropagation()} 
        />
        <div className="flex justify-between mt-2 text-xs opacity-70 font-mono">
            <span>{currentIndex} / {activeBook.chunks.length}</span>
            <span>
                Time Remaining: {Math.ceil((activeBook.chunks.length - currentIndex) / settings.wpm)} min
            </span>
        </div>
      </div>
      
      {/* Controls Overlay */}
      <div className="absolute bottom-24 flex gap-4 z-20">
        <button 
            className="bg-gray-800 p-4 rounded-full hover:bg-gray-700 active:scale-95 transition"
            onClick={(e) => {
              e.stopPropagation(); 
              setIsPlaying(!isPlaying);
            }}
        >
            {isPlaying ? (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            ) : (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3l14 9-14 9V3z"/></svg>
            )}
        </button>
      </div>

      {/* Chapter List Modal */}
      {showChapters && (
        <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-md flex justify-end animate-in slide-in-from-right duration-200" onClick={() => setShowChapters(false)}>
            <div 
                className="w-80 h-full bg-gray-900 border-l border-gray-800 flex flex-col shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="p-4 border-b border-gray-800 flex justify-between items-center bg-gray-900 sticky top-0">
                    <h2 className="text-lg font-bold text-white">Chapters</h2>
                    <button onClick={() => setShowChapters(false)} className="text-gray-400 hover:text-white">✕</button>
                </div>
                <div className="overflow-y-auto flex-1 p-2 scrollbar-thin scrollbar-thumb-gray-700">
                    {(!activeBook.chapters || activeBook.chapters.length === 0) ? (
                        <div className="p-4 text-gray-500 text-sm text-center">No chapters found.</div>
                    ) : (
                        <ul className="space-y-1">
                            {activeBook.chapters.map((chapter, i) => {
                                // Determine if this is the active chapter
                                // A chapter is active if currentIndex is >= its start AND < next chapter's start
                                const nextStart = activeBook.chapters![i+1]?.chunkIndex ?? Infinity;
                                const isActive = currentIndex >= chapter.chunkIndex && currentIndex < nextStart;

                                return (
                                    <li key={i}>
                                        <button 
                                            onClick={() => {
                                                setCurrentIndex(chapter.chunkIndex);
                                                setShowChapters(false);
                                                setIsPlaying(false);
                                            }}
                                            className={`w-full text-left px-4 py-3 rounded-lg text-sm transition ${
                                                isActive 
                                                ? 'bg-blue-600 text-white font-bold' 
                                                : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                                            }`}
                                        >
                                            <div className="flex justify-between items-baseline">
                                                <span className="truncate pr-2">{chapter.title}</span>
                                                <span className="text-xs opacity-50 font-mono">
                                                    {Math.floor((chapter.chunkIndex / activeBook.chunks.length) * 100)}%
                                                </span>
                                            </div>
                                        </button>
                                    </li>
                                )
                            })}
                        </ul>
                    )}
                </div>
            </div>
        </div>
      )}
    </div>
  );
};