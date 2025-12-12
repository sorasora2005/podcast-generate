import { exec, execSync } from 'child_process';
import util from 'util';
import fetch from 'node-fetch';

const execAsync = util.promisify(exec);

const CONTAINER_NAME = 'podcast-generate-voicevox-engine';
const IMAGE_NAME = 'voicevox/voicevox_engine:cpu-latest';
const PORT_MAPPING = '127.0.0.1:50021:50021';
const ENGINE_URL = 'http://127.0.0.1:50021';

/**
 * Custom error class for informational messages that should not be displayed as errors
 */
export class InfoMessage extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InfoMessage';
  }
}

function isDockerInstalled(): boolean {
  try {
    execSync('docker --version', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

async function doesContainerExist(): Promise<boolean> {
  if (!isDockerInstalled()) return false;
  try {
    // Check for containers in any state (running, stopped, etc.)
    const { stdout } = await execAsync(`docker ps -a -q -f name=${CONTAINER_NAME}`);
    return stdout.trim() !== '';
  } catch (e) {
    return false;
  }
}

async function isContainerRunning(): Promise<boolean> {
  if (!isDockerInstalled()) return false;
  try {
    // Check only for running containers
    const { stdout } = await execAsync(`docker ps -q -f name=${CONTAINER_NAME}`);
    return stdout.trim() !== '';
  } catch (e) {
    return false;
  }
}

/**
 * The main preparation function called by `generate` and `list-characters`.
 * It follows a state machine:
 * 1. If container doesn't exist -> create it, stop it, and tell the user to start it.
 * 2. If container exists but is stopped -> start it and wait.
 * 3. If container is running -> do nothing.
 */
export async function prepareAndStartEngine(): Promise<void> {
  if (!isDockerInstalled()) {
    throw new Error('Docker is not installed or not available in PATH. Please install Docker to continue.');
  }

  if (!(await doesContainerExist())) {
    console.log(`Container '${CONTAINER_NAME}' does not exist. Creating it for first-time use...`);
    await pullImage();
    // Create container but do not auto-start. Note the absence of '--rm'.
    const createCommand = `docker create --name ${CONTAINER_NAME} -p ${PORT_MAPPING} ${IMAGE_NAME}`;
    await execAsync(createCommand);
    throw new InfoMessage(`
----------------------------------------------------------------------------------
Container '${CONTAINER_NAME}' has been created.
Before you can generate audio, you need to start it.

Please run: npx ts-node src/cli.ts docker start

Then, re-run your previous command.
----------------------------------------------------------------------------------
`);
  }

  if (!(await isContainerRunning())) {
    console.log(`Container '${CONTAINER_NAME}' is stopped. Starting it now...`);
    await startContainer();
    console.log('Waiting for engine to initialize (10 seconds)...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    console.log('Engine started. Proceeding...');
  }
  // If we reach here, the container is running.
}

// --- Functions for direct 'docker' subcommands ---

export async function pullImage(): Promise<void> {
  if (!isDockerInstalled()) throw new Error('Docker is not installed.');
  console.log(`Pulling latest Docker image: ${IMAGE_NAME}...`);
  try {
    // Pipe stdout to the current process to show download progress
    const pullProcess = exec(`docker pull ${IMAGE_NAME}`);
    pullProcess.stdout?.pipe(process.stdout);
    pullProcess.stderr?.pipe(process.stderr);
    await new Promise((resolve, reject) => {
      pullProcess.on('close', code => code === 0 ? resolve(undefined) : reject());
    });
    console.log('Image pulled successfully.');
  } catch (error) {
    throw new Error(`Failed to pull Docker image. Please check your internet connection and Docker setup.`);
  }
}

export async function createContainer(): Promise<void> {
  if (!isDockerInstalled()) throw new Error('Docker is not installed.');
  if (await doesContainerExist()) {
    throw new Error(`Container '${CONTAINER_NAME}' already exists. To re-create it, run 'docker delete' first.`);
  }
  console.log(`Creating container '${CONTAINER_NAME}'...`);
  await pullImage();
  const createCommand = `docker create --name ${CONTAINER_NAME} -p ${PORT_MAPPING} ${IMAGE_NAME}`;
  await execAsync(createCommand);
  console.log(`Container created. Run 'docker start' to start it.`);
}

export async function startContainer(): Promise<void> {
  if (!isDockerInstalled()) throw new Error('Docker is not installed.');
  if (!(await doesContainerExist())) {
    throw new Error(`Container '${CONTAINER_NAME}' does not exist. Run 'docker create' first.`);
  }
  if (await isContainerRunning()) {
    console.log('Container is already running.');
    return;
  }
  console.log(`Starting container '${CONTAINER_NAME}'...`);
  await execAsync(`docker start ${CONTAINER_NAME}`);
  console.log('Container started.');
}

export async function stopContainer(): Promise<void> {
  if (!isDockerInstalled()) throw new Error('Docker is not installed.');
  if (!(await isContainerRunning())) {
    console.log('Container is not running.');
    return;
  }
  console.log(`Stopping container '${CONTAINER_NAME}'...`);
  await execAsync(`docker stop ${CONTAINER_NAME}`);
  console.log('Container stopped.');
}

export async function deleteContainer(): Promise<void> {
  if (!isDockerInstalled()) throw new Error('Docker is not installed.');
  if (!(await doesContainerExist())) {
    console.log(`Container '${CONTAINER_NAME}' does not exist. Nothing to delete.`);
    return;
  }
  console.log(`Deleting container '${CONTAINER_NAME}'...`);
  try {
    // Use 'rm -f' to force removal even if it's running.
    await execAsync(`docker rm -f ${CONTAINER_NAME}`);
    console.log('Container deleted successfully.');
  } catch (error) {
    throw new Error(`Failed to delete container. Error: ${error}`);
  }
}

export async function getVoiceVoxEngineStatus(): Promise<void> {
  if (!isDockerInstalled()) {
    console.log('Docker Status: Not Installed');
    return;
  }
  
  try {
    execSync('docker ps', { stdio: 'ignore' });
  } catch(e) {
    console.log('Docker Status: Daemon not running');
    return;
  }

  if (!(await doesContainerExist())) {
    console.log(`Container '${CONTAINER_NAME}': Not created`);
    return;
  }

  if (await isContainerRunning()) {
    console.log(`Container '${CONTAINER_NAME}': Running`);
    try {
      const response = await fetch(`${ENGINE_URL}/version`);
      if (response.ok) {
        const version = await response.text();
        console.log(`Engine Version: ${version.replace(/"/g, '')}`);
      }
    } catch {
      console.log('Engine Status: Container is running, but API is not responding.');
    }
  } else {
    console.log(`Container '${CONTAINER_NAME}': Stopped`);
  }
}
