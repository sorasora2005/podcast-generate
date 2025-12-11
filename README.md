# Podcast Generate CLI

This is a command-line tool to generate audio from a text file using the [VOICEVOX API](https://voicevox.su-shiki.com/).

## Prerequisites

- Node.js (v16 or later recommended)
- An API key for the VOICEVOX API

## 1. Installation

First, install the necessary dependencies.

```bash
npm install
```

This will install packages like `yargs` for the CLI interface, `dotenv` to manage environment variables, and `node-fetch` to make API requests.

## 2. Configuration

You need a VOICEVOX API key to use this tool.

1.  Create a file named `.env` in the root of the project.
2.  Copy the content of `.env.example` into it and add your API key:

    ```
    # .env
    VOICEVOX_API_KEY=YOUR_API_KEY_HERE
    ```

## 3. Usage

This CLI has two main commands: `generate` and `list-characters`.

### `list-characters`

To see a list of all available characters and their corresponding IDs, run:

```bash
npx ts-node src/cli.ts list-characters
```
This will display a table with ID, Character Name, and Style. Use the `ID` from this table for the `generate` command.

### `generate`

This command generates the audio file.

#### Create an input file

Create a text file inside the `texts/` directory. For example, `texts/intro.txt`:

```
こんにちは、これはテストです。
```

#### Running in Development

```bash
# Basic usage
npx ts-node src/cli.ts generate --text-file texts/intro.txt --output-file audio/intro.wav --character-id 1

# With optional parameters
npx ts-node src/cli.ts generate -t texts/intro.txt -o audio/intro.wav -c 1 --speed 1.2
```

#### Building for Production

First, build the TypeScript code into JavaScript:

```bash
npm run build
```

Now you can run the CLI directly via `node`.

```bash
node dist/cli.js generate --text-file texts/intro.txt --output-file audio/intro.wav --character-id 1
```

#### `generate` Command Options

| Option                | Alias | Description                                        | Required | Default |
| --------------------- | ----- | -------------------------------------------------- | -------- | ------- |
| `--text-file`         | `-t`  | Path to the input text file.                       | Yes      | -       |
| `--output-file`       | `-o`  | Path to save the output audio file.                | Yes      | -       |
| `--character-id`      | `-c`  | The ID of the VOICEVOX character (speaker).        | Yes      | -       |
| `--pitch`             |       | Pitch of the voice.                                | No       | `0`     |
| `--intonation-scale`  |       | Intonation scale of the voice.                     | No       | `1`     |
| `--speed`             |       | Speed of the voice.                                | No       | `1`     |
| `--help`              | `-h`  | Show help for the `generate` command.              | No       | -       |

The tool will print the time it took to generate the voice and save the file to your specified output path.
