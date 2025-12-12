import fetch from 'node-fetch';
import { URLSearchParams } from 'url';

/**
 * ---
 * IMPORTANT: This service communicates with a local VOICEVOX engine.
 * Before running any commands that use this service, you must start the engine using Docker:
 *
 * docker run --rm -p '127.0.0.1:50021:50021' voicevox/voicevox_engine:cpu-latest
 * ---
 */

const API_BASE_URL = 'http://127.0.0.1:50021';

export interface CharacterStyle {
  name: string;
  id: number;
}

export interface Speaker {
  name: string;
  speaker_uuid: string;
  styles: CharacterStyle[];
  version: string;
}

interface VoiceParams {
  text: string;
  characterId: number;
  pitch?: number;
  intonationScale?: number;
  speed?: number;
}

export async function getCharacters(): Promise<Speaker[]> {
  try {
    const response = await fetch(`${API_BASE_URL}/speakers`);
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Failed to get characters. Is the local engine running? Status ${response.status}: ${errorBody}`);
    }
    return response.json() as Promise<Speaker[]>;
  } catch (error) {
    throw new Error(`Failed to connect to the local VOICEVOX engine at ${API_BASE_URL}. Please ensure it is running.`);
  }
}

export async function generateVoice({
  text,
  characterId,
  pitch = 0,
  intonationScale = 1,
  speed = 1,
}: VoiceParams): Promise<Buffer> {
  try {
    // Step 1: Create an audio query from the text
    const queryParams = new URLSearchParams({
      text: text,
      speaker: String(characterId),
    });

    const audioQueryResponse = await fetch(`${API_BASE_URL}/audio_query?${queryParams.toString()}`, {
      method: 'POST',
      headers: { 'Accept': 'application/json' },
    });

    if (!audioQueryResponse.ok) {
      const errorBody = await audioQueryResponse.text();
      throw new Error(`'audio_query' request failed with status ${audioQueryResponse.status}: ${errorBody}`);
    }

    const queryJson = await audioQueryResponse.json() as any;

    // Step 2: Modify the query with specified parameters
    queryJson.pitch = pitch;
    queryJson.speed = speed;
    queryJson.intonationScale = intonationScale;

    // Step 3: Synthesize the voice from the modified query
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 3600000); // 60 minutes timeout for long audio synthesis

    try {
      const synthesisResponse = await fetch(`${API_BASE_URL}/synthesis?speaker=${characterId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(queryJson),
        signal: controller.signal,
      });

      if (!synthesisResponse.ok) {
        const errorBody = await synthesisResponse.text();
        throw new Error(`'synthesis' request failed with status ${synthesisResponse.status}: ${errorBody}`);
      }

      const arrayBuffer = await synthesisResponse.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw new Error('Voice synthesis timed out after 60 minutes.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
      throw new Error(`Failed to connect to the local VOICEVOX engine at ${API_BASE_URL}. Please ensure it is running.`);
    }
    throw error;
  }
}
