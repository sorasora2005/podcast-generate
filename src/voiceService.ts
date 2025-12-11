import 'dotenv/config';
import fetch from 'node-fetch';

const API_BASE_URL = 'https://api.su-shiki.com/v2/voicevox';

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

function getApiKey(): string {
  const apiKey = process.env.VOICEVOX_API_KEY;
  if (!apiKey) {
    throw new Error('VOICEVOX_API_KEY is not set in your environment variables.');
  }
  return apiKey;
}

export async function getCharacters(): Promise<Speaker[]> {
  const apiKey = getApiKey();
  const params = new URLSearchParams({ key: apiKey });
  const response = await fetch(`${API_BASE_URL}/speakers?${params.toString()}`);

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API request failed with status ${response.status}: ${errorBody}`);
  }

  return response.json() as Promise<Speaker[]>;
}

export async function generateVoice({
  text,
  characterId,
  pitch = 0,
  intonationScale = 1,
  speed = 1,
}: VoiceParams): Promise<Buffer> {
  const apiKey = getApiKey();

  const params = new URLSearchParams({
    key: apiKey,
    speaker: characterId.toString(),
    pitch: pitch.toString(),
    intonationScale: intonationScale.toString(),
    speed: speed.toString(),
    text: text,
  });

  const response = await fetch(`${API_BASE_URL}/audio?${params.toString()}`);

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API request failed with status ${response.status}: ${errorBody}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
