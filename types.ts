
export interface Chunk {
  text: string;
  start: number;
  end: number;
  kind: "phrase" | "word" | "entity" | "idiom";
  delayModifier?: number; // Calculated modifier for playback
  focalIndex?: number; // Calculated ORP index
}

export interface Chapter {
  title: string;
  chunkIndex: number;
}

export interface Book {
  id: string;
  title: string;
  content: string; // Full text content
  chunks: Chunk[];
  chapters?: Chapter[];
  progressIndex: number; // Index in chunks array
  createdAt: number;
  metadata?: {
    author?: string;
    publisher?: string;
    publishedDate?: string;
    fileType?: 'text' | 'epub' | 'pdf';
  };
  primingSummary?: string[]; // AI-generated 5-bullet summary
}

export type ChunkingMode = 'algorithmic' | 'ai';

export interface AppSettings {
  wpm: number;
  chunkingMode: ChunkingMode;
  apiKey: string; // OpenRouter Key
  theme: 'oled' | 'sepia' | 'high-contrast';
  fontFamily: 'sans' | 'serif' | 'mono' | 'opendyslexic' | 'lexend';
  fontSize: 'sm' | 'md' | 'lg' | 'xl';
  showReticle: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  wpm: 350,
  chunkingMode: 'algorithmic',
  apiKey: '',
  theme: 'oled',
  fontFamily: 'sans',
  fontSize: 'lg',
  showReticle: true,
};