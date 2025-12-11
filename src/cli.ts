#!/usr/bin/env node
import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import * as fs from 'fs/promises';
import * as path from 'path';
import { generateVoice, getCharacters } from './voiceService';

async function main() {
  await yargs(hideBin(process.argv))
    .scriptName('podcast-generate')
    .command(
      'generate',
      'Generate a voice file from a text file.',
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
            description: 'Path to save the output audio file (e.g., output.wav).',
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
          const textFilePath = path.resolve(argv.textFile as string);
          const outputFilePath = path.resolve(argv.outputFile as string);

          console.log(`Reading text from: ${textFilePath}`);
          const text = await fs.readFile(textFilePath, 'utf-8');

          if (!text) {
            throw new Error('Input text file is empty.');
          }

          console.log('Requesting voice generation...');
          console.time('Voice generation time');

          const audioBuffer = await generateVoice({
            text,
            characterId: argv.characterId as number,
            pitch: argv.pitch as number,
            intonationScale: argv.intonationScale as number,
            speed: argv.speed as number,
          });

          console.timeEnd('Voice generation time');

          await fs.writeFile(outputFilePath, audioBuffer);
          console.log(`Successfully saved audio to: ${outputFilePath}`);
        } catch (error) {
          console.error('An error occurred:', error instanceof Error ? error.message : String(error));
          process.exit(1);
        }
      }
    )
    .command(
      'list-characters',
      'List all available characters and their style IDs.',
      {},
      async () => {
        try {
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
          console.error('An error occurred:', error instanceof Error ? error.message : String(error));
          process.exit(1);
        }
      }
    )
    .demandCommand(1, 'You need to choose a command: generate or list-characters.')
    .help('h')
    .alias('h', 'help')
    .epilog('Copyright 2025')
    .argv;
}

main();
