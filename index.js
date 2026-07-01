import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import express from "express";

// ── Credentials ───────────────────────────────────────────────────────────────
const CLIENT_ID     = process.env.AMAZON_CLIENT_ID     || "amzn1.application-oa2-client.de8a5bed8b1e43daa99f3908f7691cf9";
const CLIENT_SECRET = process.env.AMAZON_CLIENT_SECRET || "amzn1.oa2-cs.v1.008c7a7c42e83bcce1b0a05b6c3db4392216a0a7022e6b5c8c0cf530d06e6977";
const REFRESH_TOKEN = process.env.AMAZON_REFRESH_TOKEN || "Atzr|IwEBIHt3YahpiyyJazgF4pLRVHG4aqU4klbZiQ1VcqVtmKB-9Q1dqvFNT-M62acdCP_4WC8wNB0NyidosUFwleA7WP5zZGO6DcC8HzOjJ11V-YVEwSu62I5xmHfnWE_Kw0MMnq5Bh-R44lNEVu28wHwCc0A4HFZcU_zqiJC7trfN43bOAzbxIXaFRXtGV0cR-V0qgVsjPGN4m_35vBX5wK2K5KB6wVpSmCZv_SW65KsrB4oK8Jn_iZ4fkwsqkYWhiIxTkpPRYFdESg0O3NBYNvbWY1DjeCMeTucCKTTEGF8RFEO0RcNbX1uPpAs0dBfjOwOxeKfBUrQyeOjH0xvc5rUXljL2vq69x8225ZAaZGMgTgNukVv3NdNVcXPUoqcP6PfXUFqpBQJ0e01qfUaNW3dFgTKV101k-c0ffK5XSHpoKsJCU2DVTcgtNxyqT7DQf2in8JYzt0SjHrf_bxEURPd6IlzPqTvg8gZ_IkY-yDo6QnbxeGLNhk2n5s0mZ1CkqODsnvRuVSq_zWdgoGc_GE-8EvjM6db_-UfOog3ITliRDQE6WHkfFL1wZ9r200ik9qSfXIvfiiOINgO2BVtEmnl2B_O6";
const PROFILE_ID    = process.env.AMAZON_PROFILE_ID    || "1527605537702863";
const API_BASE      = "https://advertising-api-eu.amazon.com";
const PORT          = process.env.PORT || 3000;

// ── Token cache ───────────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await axios.post("https://api.amazon.com/auth/o2/token",
    new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: REFRESH_TOKEN,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  cachedToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return cachedToken;
}

async function adsGet(path, params = {}) {
  const token = await getAccessToken();
  const res = await axios.get(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Amazon-Advertising-API-ClientId": CLIENT_ID,
      "Amazon-Advertising-API-Scope": PROFILE_ID,
    },
    params,
  });
  return res.data;
}

async function adsPost(path, body = {}) {
  const token = await getAccessToken();
  const res = await axios.post(`${API_BASE}${path}`, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Amazon-Advertising-API-ClientId": CLIENT_ID,
      "Amazon-Advertising-API-Scope": PROFILE_ID,
      "Content-Type": "application/json",
    },
  });
  return res.data;
}

async function pollReport(reportId, maxAttempts = 15) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const status = await adsGet(`/reporting/reports/${reportId}`);
    if (status.status === "COMPLETED") {
      const data = await axios.get(status.url, { responseType: "json" });
      return data.data;
    }
    if (status.status === "FAILURE") throw new Error("Report failed: " + JSON.stringify(status));
  }
  throw new Error("Report timed out");
}

// ── Tool handler ──────────────────────────────────────────────────────────────
function createServer() {
  const server = new Server(
    { name: "rubans-ads-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "get_profile",
        description: "Get Rubans Amazon Ads account profile info: account ID, marketplace, currency, timezone",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "get_campaigns",
        description: "Get all Sponsored Products campaigns for Rubans with status, budget, and bid info",
        inputSchema: { type: "object", properties: { stateFilter: { type: "string", default: "enabled,paused" } } }
      },
      {
        name: "get_ad_groups",
        description: "Get all ad groups with their campaign associations and status",
        inputSchema: { type: "object", properties: { stateFilter: { type: "string", default: "enabled,paused" } } }
      },
      {
        name: "get_keywords",
        description: "Get all keywords with bids, match type, and state for Sponsored Products campaigns",
        inputSchema: { type: "object", properties: { stateFilter: { type: "string", default: "enabled,paused" } } }
      },
      {
        name: "get_campaign_report",
        description: "Get performance report: impressions, clicks, spend, sales for a date range (YYYYMMDD format)",
        inputSchema: { type: "object", properties: { startDate: { type: "string" }, endDate: { type: "string" } }, required: ["startDate", "endDate"] }
      },
      {
        name: "get_keyword_report",
        description: "Get keyword-level performance report for a date range (YYYYMMDD format)",
        inputSchema: { type: "object", properties: { startDate: { type: "string" }, endDate: { type: "string" } }, required: ["startDate", "endDate"] }
      },
      {
        name: "get_search_term_report",
        description: "Get search term performance report for a date range (YYYYMMDD format)",
        inputSchema: { type: "object", properties: { startDate: { type: "string" }, endDate: { type: "string" } }, required: ["startDate", "endDate"] }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let result;

      if (name === "get_profile") {
        result = await adsGet("/v2/profiles");

      } else if (name === "get_campaigns") {
        result = await adsGet("/v2/sp/campaigns", {
          stateFilter: args?.stateFilter || "enabled,paused",
          count: 500
        });

      } else if (name === "get_ad_groups") {
        result = await adsGet("/v2/sp/adGroups", {
          stateFilter: args?.stateFilter || "enabled,paused",
          count: 500
        });

      } else if (name === "get_keywords") {
        result = await adsGet("/v2/sp/keywords", {
          stateFilter: args?.stateFilter || "enabled,paused",
          count: 5000
        });

      } else if (name === "get_campaign_report") {
        const reportReq = await adsPost("/reporting/reports", {
          name: "Campaign report",
          startDate: args.startDate,
          endDate: args.endDate,
          configuration: {
            adProduct: "SPONSORED_PRODUCTS",
            groupBy: ["campaign"],
            columns: ["impressions","clicks","cost","purchases14d","sales14d","campaignName","campaignStatus","campaignBudget"],
            reportTypeId: "spCampaigns",
            timeUnit: "SUMMARY",
            format: "GZIP_JSON"
          }
        });
        result = await pollReport(reportReq.reportId);

      } else if (name === "get_keyword_report") {
        const reportReq = await adsPost("/reporting/reports", {
          name: "Keyword report",
          startDate: args.startDate,
          endDate: args.endDate,
          configuration: {
            adProduct: "SPONSORED_PRODUCTS",
            groupBy: ["targeting"],
            columns: ["impressions","clicks","cost","purchases14d","sales14d","keywordText","matchType"],
            reportTypeId: "spTargeting",
            timeUnit: "SUMMARY",
            format: "GZIP_JSON"
          }
        });
        result = await pollReport(reportReq.reportId);

      } else if (name === "get_search_term_report") {
        const reportReq = await adsPost("/reporting/reports", {
          name: "Search term report",
          startDate: args.startDate,
          endDate: args.endDate,
          configuration: {
            adProduct: "SPONSORED_PRODUCTS",
            groupBy: ["searchTerm"],
            columns: ["impressions","clicks","cost","purchases14d","sales14d","searchTerm"],
            reportTypeId: "spSearchTerm",
            timeUnit: "SUMMARY",
            format: "GZIP_JSON"
          }
        });
        result = await pollReport(reportReq.reportId);

      } else {
        throw new Error(`Unknown tool: ${name}`);
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      return {
        content: [{ type: "text", text: `Error: ${err.message}\n${detail}` }],
        isError: true
      };
    }
  });

  return server;
}

// ── Express HTTP server with SSE transport ────────────────────────────────────
const app = express();
const transports = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => delete transports[transport.sessionId]);
  const server = createServer();
  await server.connect(transport);
});

app.post("/messages", express.json(), async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) return res.status(404).json({ error: "Session not found" });
  await transport.handlePostMessage(req, res);
});

app.get("/", (req, res) => {
  res.json({ status: "Rubans Amazon Ads MCP server running", profile_id: PROFILE_ID });
});

app.listen(PORT, () => {
  console.log(`Rubans Ads MCP server listening on port ${PORT}`);
});
