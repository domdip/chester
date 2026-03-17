import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".png": "image/png",
};

function resolveRepoPath(urlPath) {
  const relativePath = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.replace(/^\//, ""));
  const resolvedPath = path.resolve(rootDir, relativePath);
  if (!resolvedPath.startsWith(rootDir)) return null;
  return resolvedPath;
}

export async function startStaticServer() {
  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
    const filePath = resolveRepoPath(reqUrl.pathname);

    if (!filePath) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    try {
      const body = await readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[ext] || "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(body);
    } catch (error) {
      const status = error?.code === "ENOENT" ? 404 : 500;
      res.writeHead(status);
      res.end(status === 404 ? "Not found" : "Server error");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start static server");
  }

  return {
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    rootDir,
    url: `http://127.0.0.1:${address.port}`,
  };
}
