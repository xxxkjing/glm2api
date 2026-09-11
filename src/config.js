// glm2api 配置
import { loadEnvFile } from "node:process";

try {
  loadEnvFile();
} catch {}

const port = Number(process.env.PORT ?? 3000);
const apiKey = process.env.GLM2API_KEY ?? "";
const dataFile = process.env.GLM2API_DATA_FILE ?? "./data/glm2api.json";
const defaultModel = process.env.GLM2API_MODEL ?? "glm-5.3-flash";
const browserMode = process.env.GLM2API_BROWSER === "1" || process.env.GLM2API_BROWSER === "true";

export const config = Object.freeze({
  port,
  apiKey,
  dataFile,
  defaultModel,
  browserMode,
  models: [
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash", ownedBy: "zhipu" },
    { id: "glm-5.3", name: "GLM-5.3", ownedBy: "zhipu" },
    { id: "glm-4.7", name: "GLM-4.7", ownedBy: "zhipu" }
  ]
});
