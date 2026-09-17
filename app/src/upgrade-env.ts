import dotEnv from "dotenv";
import fs from "fs";
import path from "path";

dotEnv.config();

const envTemplatePath = path.resolve(__dirname, "..", ".env.template");
const envPath = path.resolve(__dirname, "..", ".env");

const isKeyValueLine = (line: string) => {
  return line.includes("=") && !line.startsWith("#");
};

const isKeyValueLineCommented = (line: string) => {
  const [first, second] = line.split("=");
  // first should be like "# KEY", second should be VALUE
  const [f1 = "", f2 = "", ...rest] = first.split(" ");
  return (
    f1.trim() === "#" &&
    first.length > 1 &&
    f2.trim() &&
    rest.length === 0 &&
    second !== undefined
  );
};

export const upgradeEnv = () => {
  if (fs.existsSync(envPath)) {
    const existingEnvEntities = dotEnv.parse(fs.readFileSync(envPath));
    const envTemplateLines = fs
      .readFileSync(envTemplatePath, "utf-8")
      .split("\n");

    const migratedKeys: string[] = [];
    const migrateLines = envTemplateLines.map((line) => {
      // is KEY=VALUE line
      if (isKeyValueLine(line)) {
        const [key] = line.split("=");
        if (existingEnvEntities[key] !== undefined) {
          console.log("Migrating env key:", key);
          migratedKeys.push(key);
          return `${key}=${existingEnvEntities[key]}`;
        }
      }
      // is # KEY=VALUE comment line, replace with existing value if exists and uncomment
      if (isKeyValueLineCommented(line)) {
        const uncommentedLine = line.slice(1).trim();
        const [key] = uncommentedLine.split("=");
        if (existingEnvEntities[key] !== undefined) {
          console.log("Migrating env key:", key);
          migratedKeys.push(key);
          return `${key}=${existingEnvEntities[key]}`;
        }
      }
      return line;
    });

    // append any existing keys that are not in the template
    let unknownKeysAdded = false;
    Object.keys(existingEnvEntities).forEach((key) => {
      if (!migratedKeys.includes(key)) {
        if (!unknownKeysAdded) {
          unknownKeysAdded = true;
          migrateLines.push(
            "\n\n## The following keys are from your existing .env but not present in .env.template",
          );
        }
        console.log("Appending unknown env key:", key);
        migrateLines.push(`${key}=${existingEnvEntities[key]}`);
      }
    });

    fs.writeFileSync(envPath, migrateLines.join("\n"));
    console.log(`.env file at ${envPath} has been upgraded.`);
  } else {
    // create .env from .env.template
    if (fs.existsSync(envTemplatePath)) {
      fs.copyFileSync(envTemplatePath, envPath);
      console.log(`.env file created at ${envPath} from template.`);
    } else {
      console.error(
        `.env.template file does not exist at ${envTemplatePath}, cannot create .env file.`,
      );
    }
  }
};

upgradeEnv();
