const fs = require("fs");
const path = require("path");
const localtunnel = require("localtunnel");

const root = __dirname;
const outputPath = path.join(root, "public-url.txt");
const logPath = path.join(root, "tunnel.log");

async function main() {
  const tunnel = await localtunnel({ port: 3000 });
  const message = `PUBLIC_URL=${tunnel.url}\nADMIN_URL=${tunnel.url}/admin\n`;

  fs.writeFileSync(outputPath, message, "utf8");
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}`, "utf8");
  console.log(message.trim());

  tunnel.on("close", () => {
    fs.appendFileSync(logPath, `${new Date().toISOString()} tunnel closed\n`, "utf8");
  });

  process.stdin.resume();
}

main().catch((error) => {
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${String(error)}\n`, "utf8");
  process.exit(1);
});
