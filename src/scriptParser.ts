/**
 * Script parser for dialogue mode
 * Supports format: @characterId: text or @characterId(params): text
 * 
 * Example:
 * @1: こんにちは、これはテストです。
 * @3: ずんだもんです。ID指定で話しています。
 * @1(pitch=-0.1, speed=1.2): パラメータを個別に上書きすることも可能です。
 * @3: それはすごいですね。
 */

export interface DialogueLine {
  characterId: number;
  text: string;
  pitch?: number;
  intonationScale?: number;
  speed?: number;
}

/**
 * Check if a text file is in dialogue script format
 */
export function isDialogueScript(content: string): boolean {
  const lines = content.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  if (lines.length === 0) return false;

  // Check if at least one line matches the dialogue format @ID: text
  const dialoguePattern = /^@\d+(\([^)]+\))?:\s*.+$/;
  return lines.some(line => dialoguePattern.test(line));
}

/**
 * Parse dialogue script content into DialogueLine array
 */
export function parseDialogueScript(content: string): DialogueLine[] {
  const lines = content.split('\n');
  const dialogueLines: DialogueLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines
    if (line.length === 0) continue;

    // Match format: @ID: text or @ID(params): text
    const match = line.match(/^@(\d+)(?:\(([^)]+)\))?:\s*(.+)$/);

    if (!match) {
      // If line doesn't match dialogue format, skip it with a warning
      console.warn(`Warning: Line ${i + 1} does not match dialogue format and will be skipped: "${line.substring(0, 50)}..."`);
      continue;
    }

    const characterId = parseInt(match[1], 10);
    const paramsString = match[2] || '';
    const text = match[3].trim();

    if (isNaN(characterId)) {
      console.warn(`Warning: Line ${i + 1} has invalid character ID and will be skipped: "${line.substring(0, 50)}..."`);
      continue;
    }

    if (text.length === 0) {
      console.warn(`Warning: Line ${i + 1} has empty text and will be skipped`);
      continue;
    }

    const dialogueLine: DialogueLine = {
      characterId,
      text,
    };

    // Parse parameters if present
    if (paramsString) {
      const params = parseParameters(paramsString);
      if (params.pitch !== undefined) dialogueLine.pitch = params.pitch;
      if (params.intonationScale !== undefined) dialogueLine.intonationScale = params.intonationScale;
      if (params.speed !== undefined) dialogueLine.speed = params.speed;
    }

    dialogueLines.push(dialogueLine);
  }

  return dialogueLines;
}

/**
 * Parse parameter string like "pitch=-0.1, speed=1.2"
 */
function parseParameters(paramsString: string): { pitch?: number; intonationScale?: number; speed?: number } {
  const params: { pitch?: number; intonationScale?: number; speed?: number } = {};

  // Split by comma and parse each parameter
  const paramPairs = paramsString.split(',').map(p => p.trim());

  for (const pair of paramPairs) {
    const match = pair.match(/^(\w+)\s*=\s*(-?\d+\.?\d*)$/);
    if (!match) {
      console.warn(`Warning: Invalid parameter format "${pair}", skipping`);
      continue;
    }

    const key = match[1].trim();
    const value = parseFloat(match[2]);

    if (isNaN(value)) {
      console.warn(`Warning: Invalid parameter value "${match[2]}" for "${key}", skipping`);
      continue;
    }

    switch (key) {
      case 'pitch':
        params.pitch = value;
        break;
      case 'intonationScale':
        params.intonationScale = value;
        break;
      case 'speed':
        params.speed = value;
        break;
      default:
        console.warn(`Warning: Unknown parameter "${key}", skipping`);
    }
  }

  return params;
}


















