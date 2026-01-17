import { Chunk, Chapter } from '../types';

/**
 * Calculates the Optimal Recognition Point (ORP) index for a given text token.
 * Uses the standard 35% rule.
 */
export const calculateFocalIndex = (text: string): number => {
  // Strip punctuation for length calculation to find "visual center" of the word part
  const wordPart = text.trim();
  if (wordPart.length <= 1) return 0;
  return Math.floor(wordPart.length * 0.35);
};

/**
 * Calculates the duration (ms) a chunk should be displayed.
 */
export const calculateChunkDelay = (chunk: Chunk, wpm: number): number => {
  const baseDelayMs = 60000 / wpm;
  let delay = baseDelayMs;

  const token = chunk.text.trim();
  const length = token.length;

  // 1. Length Modifier
  // Adjust base delay relative to word length slightly to smooth reading
  if (length > 10) {
    delay *= 1.3;
  } else if (length < 3) {
    delay *= 0.9;
  }

  // 2. Phrase Modifier (if it's an AI phrase, give it more time proportional to words)
  if (chunk.kind === 'phrase' || chunk.kind === 'idiom') {
    const wordCount = token.split(/\s+/).length;
    if (wordCount > 1) {
       // Base delay is per word, so multiply roughly by word count, but faster (efficiency gain)
       delay = baseDelayMs * (wordCount * 0.85); 
    }
  }

  // 3. Punctuation Modifiers
  const lastChar = token.slice(-1);
  
  // Heuristics to avoid pausing on acronyms or numbers
  
  // Acronyms: Matches "U.S.A.", "Ph.D.", "e.g.", "i.e." or single letters "T."
  // Logic: The whole token consists of pairs of (Letter + Dot)
  const isAcronym = /^([A-Za-z]\.)+$/.test(token);
  
  // Common Titles/Abbreviations: "Mr.", "Dr." etc.
  const isAbbreviation = /^(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St)\.$/i.test(token);

  // Numeric Comma: e.g. "1," in "1,000"
  const isNumericComma = /\d,$/.test(token);

  if (!isAcronym && !isAbbreviation && !isNumericComma) {
    if (['.', '!', '?'].includes(lastChar)) {
      delay += 300; // Sentence break
    } else if ([',', ';', ':'].includes(lastChar)) {
      // User requirement: Delay at 90% speed of current WPM.
      // Speed = 0.9 * wpm.
      // Delay = 60000 / (0.9 * wpm) = (60000/wpm) / 0.9 = baseDelayMs / 0.9.
      delay = baseDelayMs / 0.9;
    }
  }

  return Math.round(delay);
};

/**
 * Deterministic fallback chunker.
 * Uses a regex loop to find tokens and their exact positions, avoiding indexOf ambiguity.
 */
export const algorithmicChunker = (text: string): Chunk[] => {
  const chunks: Chunk[] = [];
  // Regex Breakdown:
  // 1. (?:[\w'’\u2019-]+[.,!?;:]*) 
  //    Matches words with apostrophes (std & smart) or dashes, optionally followed by sentence punctuation.
  // 2. (?:\S+)
  //    Matches any other sequence of non-whitespace characters (fallback for symbols, numbers, weird punctuation).
  const regex = /(?:[\w'’\u2019-]+[.,!?;:]*)|(?:\S+)/g;
  
  let match;
  while ((match = regex.exec(text)) !== null) {
    const token = match[0];
    const start = match.index;
    const end = start + token.length;
    
    chunks.push({
      text: token,
      start,
      end,
      kind: 'word' as const,
      focalIndex: calculateFocalIndex(token)
    });
  }
  
  return chunks;
};

/**
 * Scans the full text for Chapter headers and maps them to the nearest chunk index.
 */
export const extractChapters = (text: string, chunks: Chunk[]): Chapter[] => {
  const chapters: Chapter[] = [];
  
  // Regex patterns for common chapter headers.
  // 1. "Chapter One", "Chapter 1", "Part IV", "Book One"
  // 2. "Prologue", "Epilogue", "Introduction", "Preface"
  // We capture the whole line as the title.
  const regex = /(?:^|\n)\s*((?:chapter|part|book)\s+(?:[a-z]+|\d+|[ivxlcdm]+).*?|(?:prologue|epilogue|introduction|preface|foreword).*?)(?:\r?\n|$)/gim;

  let match;
  while ((match = regex.exec(text)) !== null) {
    const title = match[1].trim();
    // match.index is the start of the match (including newline), we need to find the text start.
    // The capture group 1 starts at match.index + (match[0].indexOf(match[1])) effectively.
    // But simplified: the character index in text is roughly match.index.
    
    // Find the first chunk that starts at or after this position
    const chunkIndex = chunks.findIndex(c => c.start >= match.index);
    
    if (chunkIndex !== -1) {
      // Avoid duplicate chunk indices (e.g. if multiple headers resolve to same chunk due to spacing)
      if (chapters.length === 0 || chapters[chapters.length - 1].chunkIndex !== chunkIndex) {
        chapters.push({
          title: title.length > 50 ? title.substring(0, 50) + "..." : title, // Truncate long titles
          chunkIndex
        });
      }
    }
  }

  // If no chapters found, fallback to just "Beginning"
  if (chapters.length === 0) {
    chapters.push({ title: "Start of Text", chunkIndex: 0 });
  }

  return chapters;
};