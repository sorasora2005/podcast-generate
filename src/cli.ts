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
            description: 'The ID of the character (speaker).',
            demandOption: true,
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
          });
      },
      async (argv) => {
        try {
          await prepareAndStartEngine();

          const textFilePath = path.resolve(argv.textFile as string);
          const outputFilePath = path.resolve(argv.outputFile as string);

          console.log(`Reading text from: ${textFilePath}`);
          const text = await fsPromises.readFile(textFilePath, 'utf-8');

          if (!text) {
            throw new Error('Input text file is empty.');
          }

          // Check text length limit (100,000 characters)
          const MAX_TEXT_LENGTH = 100000;
          if (text.length > MAX_TEXT_LENGTH) {
            throw new Error(`Text file is too long (${text.length} characters). Maximum allowed length is ${MAX_TEXT_LENGTH} characters.`);
          }

          const textChunks = splitText(text);

          console.log(`Splitted text into ${textChunks.length} chunks.`);
          console.log('Generating audio chunks in parallel...');
          console.time('Voice generation time');

          // Generate all audio chunks in parallel
          const audioPromises = textChunks.map((chunk, index) => {
            const chunkIndex = index + 1;
            console.log(`[${chunkIndex}/${textChunks.length}] Queued: "${chunk.substring(0, 30)}..."`);
            return generateVoice({
              text: chunk,
              characterId: argv.characterId as number,
              pitch: argv.pitch as number,
              intonationScale: argv.intonationScale as number,
              speed: argv.speed as number,
            }).then((audioBuffer) => {
              console.log(`[${chunkIndex}/${textChunks.length}] Completed: "${chunk.substring(0, 30)}..."`);
              return { index, audioBuffer };
            });
          });

          // Wait for all chunks to complete and sort by original index to maintain order
          const results = await Promise.all(audioPromises);
          const audioBuffers = results
            .sort((a, b) => a.index - b.index)
            .map(result => result.audioBuffer);

          // Clear results array to help GC
          results.length = 0;

          console.timeEnd('Voice generation time');

          console.log('Concatenating audio chunks...');

          // Read format and audio data from all WAV files
          let format: any = null;
          const audioDataChunks: Buffer[] = [];

          try {
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

              // Clear the buffer reference to help GC
              audioBuffers[i] = null as any;
            }

            if (!format) {
              throw new Error('Failed to read WAV format from first file');
            }

            // Combine all audio data
            let combinedAudioData = Buffer.concat(audioDataChunks);

            // Clear audioDataChunks immediately after combining to free memory
            audioDataChunks.length = 0;

            // Write combined audio to file
            const tempFilePath = path.join(path.dirname(outputFilePath), `temp_${Date.now()}.wav`);
            const writeStream = fs.createWriteStream(tempFilePath);
            const writer = new Writer(format);

            writer.pipe(writeStream);
            writer.write(combinedAudioData);
            writer.end();

            // Clear combinedAudioData reference after writing to help GC
            combinedAudioData = null as any;

            await new Promise<void>((resolve, reject) => {
              const cleanup = () => {
                try {
                  // Clean up event listeners
                  writer.removeAllListeners();
                  writeStream.removeAllListeners();
                  // Unpipe to break the connection
                  writer.unpipe(writeStream);
                  // Destroy streams if methods exist
                  if (typeof writeStream.destroy === 'function') {
                    writeStream.destroy();
                  }
                  if (typeof (writer as any).destroy === 'function') {
                    (writer as any).destroy();
                  }
                } catch (e) {
                  // Ignore cleanup errors
                }
              };

              writeStream.on('finish', () => {
                cleanup();
                resolve();
              });
              writeStream.on('error', (err) => {
                cleanup();
                reject(err);
              });
            });

            // Check if output should be MP3 based on file extension
            const outputExt = path.extname(outputFilePath).toLowerCase();
            const isMp3Output = outputExt === '.mp3';

            if (isMp3Output) {
              // Convert WAV to MP3
              console.log('Converting WAV to MP3...');
              const mp3FilePath = outputFilePath;
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
              await fsPromises.rename(tempFilePath, outputFilePath);
              console.log(`Successfully saved audio to: ${outputFilePath}`);
            }
          } finally {
            // Ensure cleanup even if there's an error
            audioBuffers.length = 0;
            audioDataChunks.length = 0;
          }

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
