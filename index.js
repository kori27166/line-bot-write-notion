// Render entrypoint: run as a normal Express server
const express = require("express");
const serverless = require("serverless-http");

// Import the existing serverless handler from api/server.js
// api/server.js exports: exports.handler = serverless(app);
const { handler } = require("./api/server");

// Create an Express app and mount the serverless handler
const app = express();

// LINE webhook will be POST /webhook
app.all("/webhook", (req, res) => handler(req, res));

// Optional health check endpoint
app.get("/", (req, res) => res.status(200).send("OK"));

const port = process.env.PORT || 8888;
app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on port ${port}`);
});
