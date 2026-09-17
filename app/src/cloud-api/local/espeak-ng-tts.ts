import * as fs from "fs";
import * as path from "path";
import { getAudioDurationInSeconds } from "get-audio-duration";
import { spawn } from "child_process";
import dotenv from "dotenv";
import { ttsDir } from "../../utils/dir";
import { TTSResult } from "../../type";

dotenv.config();

const espeakBinaryPath = process.env.ESPEAK_NG_BINARY_PATH || "espeak-ng";
const espeakVoice = process.env.ESPEAK_NG_VOICE || "en";
const espeakSpeed = process.env.ESPEAK_NG_SPEED || "175";
const espeakPitch = process.env.ESPEAK_NG_PITCH || "50";
const espeakAmplitude = process.env.ESPEAK_NG_AMPLITUDE || "100";

const espeakNgTTS = async (text: string): Promise<TTSResult> => {
  return new Promise((resolve) => {
    const now = Date.now();
    const tempWavFile = path.join(ttsDir, `espeakng_${now}.wav`);
    const convertedWavFile = path.join(ttsDir, `espeakng_${now}_converted.wav`);

    const espeakProcess = spawn(espeakBinaryPath, [
      "-w",
      tempWavFile,
      "-v",
      espeakVoice,
      "-s",
      espeakSpeed,
      "-p",
      espeakPitch,
      "-a",
      espeakAmplitude,
    ]);

    espeakProcess.stdin.write(text);
    espeakProcess.stdin.end();

    espeakProcess.on("close", async (code: number) => {
      if (code !== 0) {
        console.error(`espeak-ng process exited with code ${code}`);
        resolve({ duration: 0 });
        return;
      }

      if (!fs.existsSync(tempWavFile)) {
        console.log("espeak-ng output file not found:", tempWavFile);
        resolve({ duration: 0 });
        return;
      }

      try {
        const originalBuffer = fs.readFileSync(tempWavFile);
        const header = originalBuffer.subarray(0, 44);
        const originalSampleRate = header.readUInt32LE(24);
        const originalChannels = header.readUInt16LE(22);

        await new Promise<void>((res, rej) => {
          const soxProcess = spawn("sox", [
            "-v",
            "0.9",
            tempWavFile,
            "-r",
            originalSampleRate.toString(),
            "-c",
            originalChannels.toString(),
            convertedWavFile,
          ]);

          soxProcess.on("close", (soxCode: number) => {
            if (soxCode !== 0) {
              console.error(`Sox process exited with code ${soxCode}`);
              rej(new Error(`Sox process exited with code ${soxCode}`));
            } else {
              fs.unlinkSync(tempWavFile);
              res();
            }
          });
        });

        const duration = (await getAudioDurationInSeconds(convertedWavFile)) * 1000;
        resolve({ filePath: convertedWavFile, duration });
      } catch (error) {
        console.log("Error processing espeak-ng output:", `"${text}"`, error);
        resolve({ duration: 0 });
      }
    });

    espeakProcess.on("error", (error: any) => {
      console.log("espeak-ng process error:", `"${text}"`, error);
      resolve({ duration: 0 });
    });
  });
};

export default espeakNgTTS;
