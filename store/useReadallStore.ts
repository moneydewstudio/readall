import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { AppSettings, Book, Chunk, DEFAULT_SETTINGS } from '../types';

interface ReadallState {
  // App View State
  currentView: 'library' | 'reader' | 'settings';
  previousView: 'library' | 'reader'; // Track history for settings return
  
  // Data State
  activeBookId: string | null;
  activeBook: Book | null;
  books: Book[];
  
  // Reader Engine State
  isPlaying: boolean;
  currentIndex: number;
  
  // Settings
  settings: AppSettings;
  
  // Actions
  setView: (view: 'library' | 'reader' | 'settings') => void;
  loadBook: (book: Book) => void;
  setBooks: (books: Book[]) => void;
  updateSettings: (partial: Partial<AppSettings>) => void;
  
  // Data Actions
  updateBookProgress: (id: string, index: number) => void;
  removeBook: (id: string) => void;
  
  // Playback Actions (High Frequency calls should ideally stay in component refs, 
  // but we keep source of truth here for UI sync)
  setIsPlaying: (playing: boolean) => void;
  setCurrentIndex: (index: number) => void;
  advanceIndex: () => void;
  rewindIndex: (amount: number) => void;
}

export const useReadallStore = create<ReadallState>()(
  persist(
    (set, get) => ({
      currentView: 'library',
      previousView: 'library',
      activeBookId: null,
      activeBook: null,
      books: [],
      isPlaying: false,
      currentIndex: 0,
      settings: DEFAULT_SETTINGS,

      setView: (view) => set((state) => {
        // If entering settings, cache the current view as previous
        // But only if we aren't already in settings
        if (view === 'settings' && state.currentView !== 'settings') {
          return { currentView: view, previousView: state.currentView as 'library' | 'reader' };
        }
        return { currentView: view };
      }),
      
      setBooks: (books) => set({ books: Array.isArray(books) ? books : [] }),

      loadBook: (book) => {
        set({ 
          activeBook: book, 
          activeBookId: book.id, 
          currentIndex: book.progressIndex || 0,
          currentView: 'reader',
          isPlaying: false
        });
      },

      updateSettings: (partial) => 
        set((state) => ({ settings: { ...state.settings, ...partial } })),

      // Optimistically update progress in the books list and active book
      updateBookProgress: (id, index) => set((state) => {
        const safeBooks = Array.isArray(state.books) ? state.books : [];
        return {
          books: safeBooks.map(b => b.id === id ? { ...b, progressIndex: index } : b),
          activeBook: state.activeBook?.id === id ? { ...state.activeBook, progressIndex: index } : state.activeBook
        };
      }),

      // Optimistically remove book from list
      removeBook: (id) => set((state) => {
        const safeBooks = Array.isArray(state.books) ? state.books : [];
        return {
          books: safeBooks.filter(b => b.id !== id),
          activeBook: state.activeBook?.id === id ? null : state.activeBook
        };
      }),

      setIsPlaying: (playing) => set({ isPlaying: playing }),
      
      setCurrentIndex: (index) => {
        const { activeBook } = get();
        if (!activeBook) return;
        const safeIndex = Math.max(0, Math.min(index, activeBook.chunks.length - 1));
        set({ currentIndex: safeIndex });
      },

      advanceIndex: () => {
        const { currentIndex, activeBook } = get();
        if (!activeBook || currentIndex >= activeBook.chunks.length - 1) {
          set({ isPlaying: false });
          return;
        }
        set({ currentIndex: currentIndex + 1 });
      },

      rewindIndex: (amount) => {
        const { currentIndex } = get();
        set({ currentIndex: Math.max(0, currentIndex - amount) });
      }
    }),
    {
      name: 'readall-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ 
        settings: state.settings,
        // We generally don't persist activeBook full content in localStorage due to size quota.
        // We just remember IDs and fetch from IndexedDB on load (handled in App.tsx)
        activeBookId: state.activeBookId 
      }),
    }
  )
);