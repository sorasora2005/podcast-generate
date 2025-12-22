#!/usr/bin/env node
import * as fsPromises from 'fs/promises';
import * as fs from 'fs';
import * as path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { generateVoice, getCharacters } from './voiceService';
import {
  prepareAndStartEngine,
  pullImage,
  createContainer,
  startContainer,
  stopContainer,
  deleteContainer,
  getVoiceVoxEngineStatus,
  InfoMessage,
} from './dockerService';
import { Writer, Reader } from 'wav';
import { Readable } from 'stream';
import { isDialogueScript, parseDialogueScript, DialogueLine } from './scriptParser';
import cliProgress from 'cli-progress';
const ffmpeg = require('fluent-ffmpeg');

function splitText(text: string, maxLength = 600): string[] {
  const chunks: string[] = [];
  let remainingText = text;

  while (remainingText.length > 0) {
    if (remainingText.length <= maxLength) {
      chunks.push(remainingText);
      break;
    }

    const chunk = remainingText.substring(0, maxLength);
    const lastPeriodIndex = chunk.lastIndexOf('。');

    if (lastPeriodIndex !== -1) {
      chunks.push(remainingText.substring(0, lastPeriodIndex + 1));
      remainingText = remainingText.substring(lastPeriodIndex + 1).trim();
    } else {
      chunks.push(chunk);
      remainingText = remainingText.substring(maxLength).trim();
    }
  }

  return chunks;
}

/**
 * Get the duration of an audio file in seconds using ffprobe
 */
async function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err: Error | null, metadata: any) => {
      if (err) {
        reject(new Error(`Failed to get audio duration: ${err.message}`));
        return;
      }
      const duration = metadata.format.duration;
      if (typeof duration !== 'number' || isNaN(duration)) {
        reject(new Error('Failed to get valid audio duration'));
        return;
      }
      resolve(duration);
    });
  });
}

/**
 * Combine multiple WAV audio buffers into a single buffer
 */
async function combineAudioBuffers(audioBuffers: Buffer[]): Promise<Buffer> {
  if (audioBuffers.length === 0) {
    throw new Error('No audio buffers to combine');
  }

  if (audioBuffers.length === 1) {
    return audioBuffers[0];
  }

  let format: any = null;
  const audioDataChunks: Buffer[] = [];

  for (let i = 0; i < audioBuffers.length; i++) {
    const buffer = audioBuffers[i];
    const readable = new Readable();
    readable.push(buffer);
    readable.push(null); // End of stream

    const reader = new Reader();
    const chunks: Buffer[] = [];

    // Set up data handler
    reader.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    // Capture format from first file
    if (i === 0) {
      reader.on('format', (fmt: any) => {
        format = fmt;
      });
    }

    // Pipe readable to reader
    readable.pipe(reader);

    // Wait for all data to be read
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        // Clean up event listeners
        reader.removeAllListeners();
        readable.removeAllListeners();
        // Unpipe to break the connection
        readable.unpipe(reader);
        // Destroy readable if method exists
        if (typeof readable.destroy === 'function') {
          readable.destroy();
        }
      };

      reader.on('end', () => {
        if (chunks.length > 0) {
          audioDataChunks.push(Buffer.concat(chunks));
        }
        cleanup();
        resolve();
      });
      reader.on('error', (err) => {
        cleanup();
        reject(err);
      });
    });
  }

  if (!format) {
    throw new Error('Failed to read WAV format from first file');
  }

  // Combine all audio data
  const combinedAudioData = Buffer.concat(audioDataChunks);

  // Create a new WAV buffer with the combined data
  const tempBuffer: Buffer[] = [];
  const writer = new Writer(format);

  writer.on('data', (chunk: Buffer) => {
    tempBuffer.push(chunk);
  });

  writer.write(combinedAudioData);
  writer.end();

  // Wait for writer to finish
  await new Promise<void>((resolve, reject) => {
    writer.on('end', () => {
      resolve();
    });
    writer.on('error', (err) => {
      reject(err);
    });
  });

  return Buffer.concat(tempBuffer);
}

interface GenerateAudioOptions {
  textFilePath: string;
  outputFilePath: string;
  characterId?: number;
  pitch?: number;
  intonationScale?: number;
  speed?: number;
  bgmFile?: string;
  bgmVolume?: number;
}

/**
 * Generate audio from text file
 */
async function generateAudio(options: GenerateAudioOptions): Promise<void> {
  const {
    textFilePath,
    outputFilePath,
    characterId,
    pitch = 0,
    intonationScale = 1,
    speed = 1,
    bgmFile,
    bgmVolume = 0.05,
  } = options;

  const resolvedTextFilePath = path.resolve(textFilePath);
  const resolvedOutputFilePath = path.resolve(outputFilePath);

  console.log(`Reading text from: ${resolvedTextFilePath}`);
  const text = await fsPromises.readFile(resolvedTextFilePath, 'utf-8');

  if (!text) {
    throw new Error('Input text file is empty.');
  }

  // Check text length limit (100,000 characters)
  const MAX_TEXT_LENGTH = 100000;
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error(`Text file is too long (${text.length} characters). Maximum allowed length is ${MAX_TEXT_LENGTH} characters.`);
  }

  // Validate output directory exists
  const outputDir = path.dirname(resolvedOutputFilePath);
  try {
    await fsPromises.access(outputDir, fs.constants.F_OK);
  } catch {
    throw new Error(`Output directory does not exist: ${outputDir}`);
  }

  // Validate BGM file if specified (before starting voice generation)
  let resolvedBgmFilePath: string | undefined;
  if (bgmFile) {
    // Resolve BGM file path (supports both relative and absolute paths)
    resolvedBgmFilePath = path.isAbsolute(bgmFile)
      ? bgmFile
      : path.resolve(bgmFile);

    // Check if BGM file exists
    try {
      await fsPromises.access(resolvedBgmFilePath, fs.constants.F_OK);
    } catch {
      throw new Error(`BGM file not found: ${resolvedBgmFilePath}`);
    }
  }

  // Detect if this is a dialogue script
  const isDialogue = isDialogueScript(text);

  let audioBuffers: Buffer[];

  if (isDialogue) {
    // Dialogue mode: parse script and generate audio for each line
    console.log('Detected dialogue script format. Processing in dialogue mode...');
    const dialogueLines = parseDialogueScript(text);

    if (dialogueLines.length === 0) {
      throw new Error('No valid dialogue lines found in the script.');
    }

    console.log(`Found ${dialogueLines.length} dialogue lines.`);
    console.log('Generating audio for each line...');
    console.time('Voice generation time');

    // Default parameters
    const defaultPitch = pitch;
    const defaultIntonationScale = intonationScale;
    const defaultSpeed = speed;

    // Calculate total number of chunks across all lines
    const totalChunks = dialogueLines.reduce((sum, line) => {
      return sum + splitText(line.text).length;
    }, 0);

    // Create progress bar
    const progressBar = new cliProgress.SingleBar({
      format: 'Progress |{bar}| {percentage}% | {value}/{total} chunks completed',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
    });
    progressBar.start(totalChunks, 0);

    let completedCount = 0;

    // Generate audio for each dialogue line
    const audioPromises = dialogueLines.map((line, index) => {
      const lineIndex = index + 1;
      const lineCharacterId = line.characterId;
      const linePitch = line.pitch ?? defaultPitch;
      const lineIntonationScale = line.intonationScale ?? defaultIntonationScale;
      const lineSpeed = line.speed ?? defaultSpeed;

      // Split long text into chunks if needed
      const textChunks = splitText(line.text);

      // Generate audio for each chunk of this line
      const chunkPromises = textChunks.map((chunk, chunkIndex) => {
        return generateVoice({
          text: chunk,
          characterId: lineCharacterId,
          pitch: linePitch,
          intonationScale: lineIntonationScale,
          speed: lineSpeed,
        }).then((audioBuffer) => {
          completedCount++;
          progressBar.update(completedCount);
          return { chunkIndex, audioBuffer };
        });
      });

      return Promise.all(chunkPromises).then(chunkResults => {
        // Sort chunks by index and combine them for this line
        const sortedChunks = chunkResults
          .sort((a, b) => a.chunkIndex - b.chunkIndex)
          .map(result => result.audioBuffer);

        // Combine chunks for this line into a single buffer
        return combineAudioBuffers(sortedChunks).then(combinedBuffer => ({
          lineIndex,
          audioBuffer: combinedBuffer,
        }));
      });
    });

    // Wait for all lines to complete
    const results = await Promise.all(audioPromises);
    progressBar.stop();
    audioBuffers = results
      .sort((a, b) => a.lineIndex - b.lineIndex)
      .map(result => result.audioBuffer);

    console.timeEnd('Voice generation time');
  } else {
    // Single-speaker mode: use existing logic
    if (characterId === undefined) {
      throw new Error('Character ID is required for single-speaker mode. Use -c or --character-id option.');
    }

    const textChunks = splitText(text);

    console.log(`Splitted text into ${textChunks.length} chunks.`);
    console.log('Generating audio chunks in parallel...');
    console.time('Voice generation time');

    // Create progress bar
    const progressBar = new cliProgress.SingleBar({
      format: 'Progress |{bar}| {percentage}% | {value}/{total} chunks completed',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
    });
    progressBar.start(textChunks.length, 0);

    let completedCount = 0;

    // Generate all audio chunks in parallel
    const audioPromises = textChunks.map((chunk, index) => {
      return generateVoice({
        text: chunk,
        characterId: characterId,
        pitch: pitch,
        intonationScale: intonationScale,
        speed: speed,
      }).then((audioBuffer) => {
        completedCount++;
        progressBar.update(completedCount);
        return { index, audioBuffer };
      });
    });

    // Wait for all chunks to complete and sort by original index to maintain order
    const results = await Promise.all(audioPromises);
    progressBar.stop();
    audioBuffers = results
      .sort((a, b) => a.index - b.index)
      .map(result => result.audioBuffer);

    // Clear results array to help GC
    results.length = 0;

    console.timeEnd('Voice generation time');
  }

  console.log('Concatenating audio chunks...');

  // Combine all audio buffers into a single buffer
  const finalAudioBuffer = await combineAudioBuffers(audioBuffers);

  // Clear audioBuffers to help GC
  audioBuffers.length = 0;

  // Write combined audio to file
  const tempFilePath = path.join(path.dirname(resolvedOutputFilePath), `temp_${Date.now()}.wav`);
  await fsPromises.writeFile(tempFilePath, finalAudioBuffer);

  // BGM合成処理（バリデーションは既に完了している）
  if (resolvedBgmFilePath) {
    console.log(`Adding BGM: ${path.basename(resolvedBgmFilePath)} (volume: ${bgmVolume})...`);

    // Get voice and BGM duration
    const voiceDuration = await getAudioDuration(tempFilePath);
    const bgmDuration = await getAudioDuration(resolvedBgmFilePath);

    // Check if output should be MP3 based on file extension
    const outputExt = path.extname(resolvedOutputFilePath).toLowerCase();
    const isMp3Output = outputExt === '.mp3';

    // Create temporary output file for BGM mixing
    const tempOutputPath = path.join(
      path.dirname(resolvedOutputFilePath),
      `temp_bgm_${Date.now()}.${isMp3Output ? 'mp3' : 'wav'}`
    );

    // Mix BGM with voice using FFmpeg
    await new Promise<void>((resolve, reject) => {
      let command: any;

      // If BGM is shorter than voice, we need to loop it using concat filter
      if (bgmDuration < voiceDuration) {
        // Calculate how many times we need to loop BGM
        const loopCount = Math.ceil(voiceDuration / bgmDuration);

        // Create command with multiple inputs for BGM looping
        command = ffmpeg()
          .input(tempFilePath);

        // Add BGM file multiple times for looping
        for (let i = 0; i < loopCount; i++) {
          command = command.input(resolvedBgmFilePath);
        }

        // Create concat filter inputs (BGM inputs start from index 1)
        const concatInputs: string[] = [];
        for (let i = 0; i < loopCount; i++) {
          concatInputs.push(`[${i + 1}:a]`);
        }
        const concatFilter = `${concatInputs.join('')}concat=n=${loopCount}:v=0:a=1[bg_loop]`;

        command = command.complexFilter([
          concatFilter,
          `[bg_loop]volume=${bgmVolume}[bg]`,
          `[0:a][bg]amix=inputs=2:duration=first:dropout_transition=2[out]`,
        ])
          .outputOptions(['-map', '[out]']);
      } else {
        // BGM is longer than voice, just use it as is
        command = ffmpeg()
          .input(tempFilePath)
          .input(resolvedBgmFilePath)
          .complexFilter([
            `[1:a]volume=${bgmVolume}[bg]`,
            `[0:a][bg]amix=inputs=2:duration=first:dropout_transition=2[out]`,
          ])
          .outputOptions(['-map', '[out]']);
      }

      if (isMp3Output) {
        command
          .audioCodec('libmp3lame')
          .audioBitrate(128)
          .audioChannels(2)
          .audioFrequency(44100)
          .format('mp3');
      } else {
        command
          .audioChannels(2)
          .audioFrequency(44100)
          .format('wav');
      }

      command
        .on('end', () => {
          resolve();
        })
        .on('error', (err: Error) => {
          reject(
            new Error(
              `BGM mixing failed: ${err.message}. Make sure FFmpeg is installed on your system.`
            )
          );
        })
        .save(tempOutputPath);
    });

    // Move temp output to final output
    await fsPromises.rename(tempOutputPath, resolvedOutputFilePath);

    // Delete temporary WAV file
    await fsPromises.unlink(tempFilePath);
    console.log(`Successfully saved audio with BGM to: ${resolvedOutputFilePath}`);
  } else {
    // No BGM: use existing logic
    // Check if output should be MP3 based on file extension
    const outputExt = path.extname(resolvedOutputFilePath).toLowerCase();
    const isMp3Output = outputExt === '.mp3';

    if (isMp3Output) {
      // Convert WAV to MP3
      console.log('Converting WAV to MP3...');
      const mp3FilePath = resolvedOutputFilePath;
      const wavFilePath = tempFilePath;

      await new Promise<void>((resolve, reject) => {
        ffmpeg(wavFilePath)
          .audioCodec('libmp3lame')
          .audioBitrate(128)
          .audioChannels(2)
          .audioFrequency(44100)
          .format('mp3')
          .on('end', () => {
            resolve();
          })
          .on('error', (err: Error) => {
            reject(new Error(`MP3 conversion failed: ${err.message}. Make sure FFmpeg is installed on your system.`));
          })
          .save(mp3FilePath);
      });

      // Delete temporary WAV file
      await fsPromises.unlink(wavFilePath);
      console.log(`Successfully saved audio to: ${mp3FilePath}`);
    } else {
      // Keep as WAV
      await fsPromises.rename(tempFilePath, resolvedOutputFilePath);
      console.log(`Successfully saved audio to: ${resolvedOutputFilePath}`);
    }
  }
}

async function main() {
  await yargs(hideBin(process.argv))
    .scriptName('podcast-generate')
    .command(
      'generate',
      'Generate a voice file. Manages the VOICEVOX engine container.',
      (yargs) => {
        return yargs
          .option('text-file', {
            alias: 't',
            type: 'string',
            description: 'Path to the input text file.',
            demandOption: true,
          })
          .option('output-file', {
            alias: 'o',
            type: 'string',
            description: 'Path to save the output audio file (e.g., output.mp3 or output.wav). If .mp3 extension is used, the file will be converted to MP3 format.',
            demandOption: true,
          })
          .option('character-id', {
            alias: 'c',
            type: 'number',
            description: 'The ID of the character (speaker). Required for single-speaker mode, optional for dialogue mode (used as default).',
            demandOption: false,
          })
          .option('pitch', {
            type: 'number',
            description: 'Pitch of the voice.',
            default: 0,
          })
          .option('intonation-scale', {
            type: 'number',
            description: 'Intonation scale of the voice.',
            default: 1,
          })
          .option('speed', {
            type: 'number',
            description: 'Speed of the voice.',
            default: 1,
          })
          .option('bgm', {
            alias: 'b',
            type: 'string',
            description: 'Path to the BGM file (e.g., bgm/jazz.mp3 or /path/to/bgm.mp3). If not specified, no BGM will be added.',
            demandOption: false,
          })
          .option('bgm-volume', {
            type: 'number',
            description: 'BGM volume ratio relative to voice (0.0 to 1.0). Default is 0.05 (5% of voice volume).',
            default: 0.05,
          });
      },
      async (argv) => {
        try {
          await prepareAndStartEngine();

          await generateAudio({
            textFilePath: argv.textFile as string,
            outputFilePath: argv.outputFile as string,
            characterId: argv.characterId as number | undefined,
            pitch: argv.pitch as number,
            intonationScale: argv.intonationScale as number,
            speed: argv.speed as number,
            bgmFile: argv.bgm as string | undefined,
            bgmVolume: argv.bgmVolume as number,
          });

        } catch (error) {
          if (error instanceof InfoMessage) {
            console.log(error.message);
            process.exit(0);
          } else {
            console.error(error instanceof Error ? `\nError: ${error.message}\n` : String(error));
            process.exit(1);
          }
        }
      }
    )
    .command(
      'batch-generate',
      'Batch generate audio files from all script/txt files in a texts directory.',
      (yargs) => {
        return yargs
          .option('directory', {
            alias: 'd',
            type: 'string',
            description: 'Directory name under texts/ (e.g., 1222 or hoge).',
            demandOption: true,
          })
          .option('character-id', {
            alias: 'c',
            type: 'number',
            description: 'The ID of the character (speaker). Required for single-speaker mode, optional for dialogue mode (used as default).',
            demandOption: false,
          })
          .option('pitch', {
            type: 'number',
            description: 'Pitch of the voice.',
            default: 0,
          })
          .option('intonation-scale', {
            type: 'number',
            description: 'Intonation scale of the voice.',
            default: 1,
          })
          .option('speed', {
            type: 'number',
            description: 'Speed of the voice.',
            default: 1,
          })
          .option('bgm', {
            alias: 'b',
            type: 'string',
            description: 'Path to the BGM file (e.g., bgm/jazz.mp3 or /path/to/bgm.mp3). If not specified, no BGM will be added.',
            demandOption: false,
          })
          .option('bgm-volume', {
            type: 'number',
            description: 'BGM volume ratio relative to voice (0.0 to 1.0). Default is 0.05 (5% of voice volume).',
            default: 0.05,
          });
      },
      async (argv) => {
        try {
          await prepareAndStartEngine();

          const dirName = argv.directory as string;
          const textsDir = path.resolve('texts', dirName);
          const audioDir = path.resolve('audio', dirName);

          // Check if texts directory exists
          try {
            await fsPromises.access(textsDir, fs.constants.F_OK);
          } catch {
            throw new Error(`Texts directory does not exist: ${textsDir}`);
          }

          // Create audio directory if it doesn't exist
          try {
            await fsPromises.access('audio', fs.constants.F_OK);
          } catch {
            await fsPromises.mkdir('audio', { recursive: true });
            console.log(`Created audio directory: ${path.resolve('audio')}`);
          }

          // Create audio subdirectory if it doesn't exist
          try {
            await fsPromises.access(audioDir, fs.constants.F_OK);
          } catch {
            await fsPromises.mkdir(audioDir, { recursive: true });
            console.log(`Created audio directory: ${audioDir}`);
          }

          // Read all files in texts directory
          const files = await fsPromises.readdir(textsDir);
          const scriptFiles = files.filter(file => {
            const ext = path.extname(file).toLowerCase();
            return ext === '.script' || ext === '.txt';
          });

          if (scriptFiles.length === 0) {
            console.log(`No .script or .txt files found in ${textsDir}`);
            return;
          }

          console.log(`Found ${scriptFiles.length} script/txt files to process.`);

          // Check which files already have corresponding MP3 files
          const filesToProcess: string[] = [];
          const filesToSkip: string[] = [];

          for (const file of scriptFiles) {
            const baseName = path.basename(file, path.extname(file));
            const mp3Path = path.join(audioDir, `${baseName}.mp3`);

            try {
              await fsPromises.access(mp3Path, fs.constants.F_OK);
              filesToSkip.push(file);
            } catch {
              filesToProcess.push(file);
            }
          }

          if (filesToSkip.length > 0) {
            console.log(`Skipping ${filesToSkip.length} files (already converted):`);
            filesToSkip.forEach(file => console.log(`  - ${file}`));
          }

          if (filesToProcess.length === 0) {
            console.log('All files have already been converted.');
            return;
          }

          console.log(`\nProcessing ${filesToProcess.length} files:`);
          filesToProcess.forEach(file => console.log(`  - ${file}`));
          console.log('');

          // Process each file
          for (let i = 0; i < filesToProcess.length; i++) {
            const file = filesToProcess[i];
            const textFilePath = path.join(textsDir, file);
            const baseName = path.basename(file, path.extname(file));
            const outputFilePath = path.join(audioDir, `${baseName}.mp3`);

            console.log(`\n[${i + 1}/${filesToProcess.length}] Processing: ${file}`);
            console.log(`  Input: ${textFilePath}`);
            console.log(`  Output: ${outputFilePath}`);

            try {
              await generateAudio({
                textFilePath: textFilePath,
                outputFilePath: outputFilePath,
                characterId: argv.characterId as number | undefined,
                pitch: argv.pitch as number,
                intonationScale: argv.intonationScale as number,
                speed: argv.speed as number,
                bgmFile: argv.bgm as string | undefined,
                bgmVolume: argv.bgmVolume as number,
              });
              console.log(`  ✓ Successfully converted: ${file}`);
            } catch (error) {
              console.error(`  ✗ Failed to convert ${file}: ${error instanceof Error ? error.message : String(error)}`);
              // Continue with next file instead of stopping
            }
          }

          console.log(`\n✓ Batch processing completed. Processed ${filesToProcess.length} files.`);

        } catch (error) {
          if (error instanceof InfoMessage) {
            console.log(error.message);
            process.exit(0);
          } else {
            console.error(error instanceof Error ? `\nError: ${error.message}\n` : String(error));
            process.exit(1);
          }
        }
      }
    )
    .command(
      'list-characters',
      'List all available characters. Manages the VOICEVOX engine container.',
      {},
      async () => {
        try {
          await prepareAndStartEngine();
          console.log('Fetching available characters...');
          const speakers = await getCharacters();
          const characterTable = speakers.flatMap(speaker =>
            speaker.styles.map(style => ({
              ID: style.id,
              Character: speaker.name,
              Style: style.name,
            }))
          );
          console.table(characterTable);
        } catch (error) {
          if (error instanceof InfoMessage) {
            console.log(error.message);
            process.exit(0);
          } else {
            console.error(error instanceof Error ? `\nError: ${error.message}\n` : String(error));
            process.exit(1);
          }
        }
      }
    )
    .command(
      'docker <action>',
      'Manage the VOICEVOX engine Docker container.',
      (yargs) => {
        return yargs.positional('action', {
          describe: 'The action to perform',
          type: 'string',
          choices: ['pull', 'create', 'start', 'stop', 'delete', 'status'],
        });
      },
      async (argv) => {
        try {
          switch (argv.action) {
            case 'pull':
              await pullImage();
              break;
            case 'create':
              await createContainer();
              break;
            case 'start':
              await startContainer();
              break;
            case 'stop':
              await stopContainer();
              break;
            case 'delete':
              await deleteContainer();
              break;
            case 'status':
              await getVoiceVoxEngineStatus();
              break;
          }
        } catch (error) {
          console.error(error instanceof Error ? `Error: ${error.message}` : String(error));
          process.exit(1);
        }
      }
    )
    .demandCommand(1, 'You need at least one command before moving on.')
    .help('h')
    .alias('h', 'help')
    .epilog('Copyright 2025')
    .argv;
}

main();
