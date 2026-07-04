const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

require("./read-env");

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL não encontrado. Crie backend/.env usando backend/.env.example.");
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("supabase.com") ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await client.query(schema);
  await client.end();
  console.log("Migração concluída.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
