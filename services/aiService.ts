import { Chunk } from '../types';
import { algorithmicChunker, calculateFocalIndex } from './rsvpUtils';

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "gpt-oss-120b"; // As requested by user

interface AIResponse {
  chunks: Array<{
    text: string;
    kind: "phrase" | "word" | "entity" | "idiom";
  }>
}

interface PrimingResponse {
  summary: string[];
}

/**
 * Helper to robustly extract JSON from potentially messy LLM output.
 * Tries to find the JSON object between the first '{' and last '}'.
 */
const extractJSON = <T>(text: string): T => {
  // 1. Attempt to find the JSON object boundaries
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  
  if (start !== -1 && end !== -1 && end > start) {
    const jsonCandidate = text.substring(start, end + 1);
    try {
      return JSON.parse(jsonCandidate);
    } catch (e) {
      // If direct parse fails, try aggressive cleanup of newlines/tabs that might break strict JSON
      // But typically JSON.parse handles whitespace well. 
      // Common issue: Escaped quotes or trailing commas (though JSON standard forbids trailing commas, LLMs sometimes add them)
      console.warn("Direct JSON extraction failed, retrying with cleanup", e);
    }
  }

  // 2. Fallback: Try to clean markdown code blocks if the boundaries logic failed or parse failed
  // This handles cases where there might be text outside but our start/end logic missed nested structures or something.
  const cleanMarkdown = text.replace(/```json\s*|\s*```/g, '').trim();
  try {
      return JSON.parse(cleanMarkdown);
  } catch (e) {
      throw new Error(`Failed to parse JSON response: ${text.substring(0, 50)}...`);
  }
};

/**
 * Sends a text segment to OpenRouter for semantic chunking.
 * Falls back to algorithmic chunker on failure.
 */
export const semanticChunkText = async (
  text: string, 
  apiKey: string
): Promise<Chunk[]> => {
  if (!apiKey) {
    console.warn("No API key provided, falling back to algorithmic chunking.");
    return algorithmicChunker(text);
  }

  // Cap input size to avoid token limits/latency issues (e.g. 200 words per request)
  // For the demo, we assume the text passed in is a manageable section (paragraph).
  
  const systemPrompt = `
You are a semantic chunking engine for an RSVP speed reader. 
Break the user's text into reading chunks (words, short phrases, idioms, or entities).
Max words per chunk: 5. 
Prefer chunking noun phrases together. 
Keep punctuation attached to the preceding word.
Output JSON ONLY: { "chunks": [ { "text": string, "kind": "phrase"|"word"|"entity"|"idiom" } ] }
`;

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Readall',
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.1, // Deterministic
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API Error: ${response.statusText}`);
    }

    const data = await response.json();
    const rawContent = data.choices?.[0]?.message?.content;
    
    if (!rawContent) throw new Error("No content in response");

    const parsed: AIResponse = extractJSON<AIResponse>(rawContent);

    // Re-map to original offsets
    let currentSearchIndex = 0;
    const finalChunks: Chunk[] = [];
    
    // Safety check for malformed parsed data
    if (!parsed.chunks || !Array.isArray(parsed.chunks)) {
        throw new Error("Invalid JSON structure: missing chunks array");
    }

    for (const item of parsed.chunks) {
      const start = text.indexOf(item.text, currentSearchIndex);
      if (start === -1) {
        // Fallback logic if AI hallucinated text not in source
        // In a strict app, we might revert to algorithmic for this segment
        continue; 
      }
      const end = start + item.text.length;
      currentSearchIndex = end;

      finalChunks.push({
        text: item.text,
        start,
        end,
        kind: item.kind,
        focalIndex: calculateFocalIndex(item.text)
      });
    }

    return finalChunks;

  } catch (err) {
    console.error("Semantic chunking failed:", err);
    return algorithmicChunker(text);
  }
};

/**
 * Generates a 5-bullet point summary of the text to prime the reader.
 */
export const generatePrimingSummary = async (
  text: string, 
  apiKey: string
): Promise<string[] | null> => {
  if (!apiKey || !text) return null;

  const systemPrompt = `
You are an expert reading assistant. Your goal is to "prime" the reader before they start a new text.
Analyze the provided text (which is the beginning of a document) and identify the key themes, main characters, or core arguments.
Output exactly 5 distinct, high-value bullet points.
Output JSON ONLY: { "summary": [ "string", "string", "string", "string", "string" ] }
`;

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Readall',
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ]
      })
    });

    if (!response.ok) return null;

    const data = await response.json();
    const rawContent = data.choices?.[0]?.message?.content;
    if (!rawContent) return null;

    const parsed = extractJSON<PrimingResponse>(rawContent);

    return parsed.summary || null;
  } catch (err) {
    console.error("Priming generation failed:", err);
    return null;
  }
};