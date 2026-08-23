import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import express from "express";
import zlib from "zlib";

// Fetches a report file URL, decompresses the gzip body, and parses the JSON inside.
async function fetchReportFile(url) {
  const res = await axios.get(url, { responseType: "arraybuffer" });
  const decompressed = zlib.gunzipSync(res.data);
  return JSON.parse(decompressed.toString("utf-8"));
}

// SECURITY: no hardcoded fallbacks. Set these in Render's Environment tab.
const CLIENT_ID     = process.env.AMAZON_CLIENT_ID;
const CLIENT_SECRET = process.env.AMAZON_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.AMAZON_REFRESH_TOKEN;
const PROFILE_ID    = process.env.AMAZON_PROFILE_ID || "1527605537702863";
const API_BASE      = "https://advertising-api-eu.amazon.com";
const PORT          = process.env.PORT || 3000;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error("Missing required env vars: AMAZON_CLIENT_ID, AMAZON_CLIENT_SECRET, AMAZON_REFRESH_TOKEN");
  process.exit(1);
}

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await axios.post("https://api.amazon.com/auth/o2/token",
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: REFRESH_TOKEN, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  cachedToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return cachedToken;
}

async function adsGet(path, params = {}) {
  const token = await getAccessToken();
  const res = await axios.get(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Amazon-Advertising-API-ClientId": CLIENT_ID, "Amazon-Advertising-API-Scope": PROFILE_ID },
    params,
  });
  return res.data;
}

async function adsPost(path, body = {}) {
  const token = await getAccessToken();
  const res = await axios.post(`${API_BASE}${path}`, body, {
    headers: { Authorization: `Bearer ${token}`, "Amazon-Advertising-API-ClientId": CLIENT_ID, "Amazon-Advertising-API-Scope": PROFILE_ID, "Content-Type": "application/json" },
  });
  return res.data;
}

// v3 Sponsored Products endpoints need specific vendor content-type/accept headers
async function adsPostV3(path, body, contentType) {
  const token = await getAccessToken();
  const res = await axios.post(`${API_BASE}${path}`, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Amazon-Advertising-API-ClientId": CLIENT_ID,
      "Amazon-Advertising-API-Scope": PROFILE_ID,
      "Content-Type": contentType,
      "Accept": contentType,
    },
  });
  return res.data;
}

// map old lowercase comma-separated stateFilter (e.g. "enabled,paused") to v3 uppercase array
function toV3States(stateFilter) {
  const defaultStates = ["ENABLED", "PAUSED"];
  if (!stateFilter) return defaultStates;
  return stateFilter.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
}

async function pollReport(reportId, maxAttempts = 178) {
  // Amazon's async reports can take 15+ minutes to generate.
  // 178 attempts x 5s + 10s initial delay = ~15 minutes total.
  await new Promise(r => setTimeout(r, 10000));
  for (let i = 0; i < maxAttempts; i++) {
    const status = await adsGet(`/reporting/reports/${reportId}`);
    if (status.status === "COMPLETED") {
      return await fetchReportFile(status.url);
    }
    if (status.status === "FAILURE" || status.status === "CANCELLED") {
      throw new Error("Report failed: " + JSON.stringify(status));
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`Report timed out after 15 minutes (reportId: ${reportId}, check status manually via adsGet('/reporting/reports/${reportId}'))`);
}

function createServer() {
  const server = new Server(
    { name: "rubans-ads-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "get_profile", description: "Get Rubans Amazon Ads account profile info", inputSchema: { type: "object", properties: {} } },
      { name: "get_campaigns", description: "Get all Sponsored Products campaigns for Rubans", inputSchema: { type: "object", properties: { stateFilter: { type: "string", default: "enabled,paused" } } } },
      { name: "get_ad_groups", description: "Get all ad groups", inputSchema: { type: "object", properties: { stateFilter: { type: "string", default: "enabled,paused" } } } },
      { name: "get_keywords", description: "Get all keywords with bids and match type", inputSchema: { type: "object", properties: { stateFilter: { type: "string", default: "enabled,paused" } } } },
      { name: "get_campaign_report", description: "Get campaign performance report (YYYYMMDD dates)", inputSchema: { type: "object", properties: { startDate: { type: "string" }, endDate: { type: "string" } }, required: ["startDate", "endDate"] } },
      { name: "get_keyword_report", description: "Get keyword performance report (YYYYMMDD dates)", inputSchema: { type: "object", properties: { startDate: { type: "string" }, endDate: { type: "string" } }, required: ["startDate", "endDate"] } },
      { name: "get_search_term_report", description: "Get search term performance report (YYYYMMDD dates)", inputSchema: { type: "object", properties: { startDate: { type: "string" }, endDate: { type: "string" } }, required: ["startDate", "endDate"] } },
      { name: "get_advertised_product_report", description: "Get ASIN-level advertised product performance report - spend, sales, clicks, purchases per product (YYYYMMDD dates)", inputSchema: { type: "object", properties: { startDate: { type: "string" }, endDate: { type: "string" } }, required: ["startDate", "endDate"] } },
      { name: "get_report_by_id", description: "Check status of a specific report by ID, and pull its data if already completed (no new report is generated)", inputSchema: { type: "object", properties: { reportId: { type: "string" } }, required: ["reportId"] } },
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let result;
      if (name === "get_profile") {
        result = await adsGet("/v2/profiles");

      } else if (name === "get_campaigns") {
        // v3 Sponsored Products campaigns - POST /sp/campaigns/list
        result = await adsPostV3(
          "/sp/campaigns/list",
          {
            stateFilter: { include: toV3States(args?.stateFilter) },
            maxResults: 500,
          },
          "application/vnd.spCampaign.v3+json"
        );

      } else if (name === "get_ad_groups") {
        // v3 Sponsored Products ad groups - POST /sp/adGroups/list
        result = await adsPostV3(
          "/sp/adGroups/list",
          {
            stateFilter: { include: toV3States(args?.stateFilter) },
            maxResults: 500,
          },
          "application/vnd.spAdGroup.v3+json"
        );

      } else if (name === "get_keywords") {
        // v3 Sponsored Products keywords - POST /sp/keywords/list
        result = await adsPostV3(
          "/sp/keywords/list",
          {
            stateFilter: { include: toV3States(args?.stateFilter) },
            maxResults: 1000, // v3 caps at 1000 per page; pagination via nextToken not yet implemented
          },
          "application/vnd.spKeyword.v3+json"
        );

      } else if (name === "get_campaign_report") {
        const r = await adsPost("/reporting/reports", { name: "Campaign report", startDate: args.startDate, endDate: args.endDate, configuration: { adProduct: "SPONSORED_PRODUCTS", groupBy: ["campaign"], columns: ["startDate","endDate","campaignId","campaignName","campaignStatus","campaignBudgetAmount","impressions","clicks","cost","purchases14d","sales14d"], reportTypeId: "spCampaigns", timeUnit: "SUMMARY", format: "GZIP_JSON" } });
        result = await pollReport(r.reportId);
      } else if (name === "get_keyword_report") {
        const r = await adsPost("/reporting/reports", { name: "Keyword report", startDate: args.startDate, endDate: args.endDate, configuration: { adProduct: "SPONSORED_PRODUCTS", groupBy: ["targeting"], columns: ["startDate","endDate","campaignId","adGroupId","keywordId","keyword","matchType","impressions","clicks","cost","purchases14d","sales14d"], reportTypeId: "spTargeting", timeUnit: "SUMMARY", format: "GZIP_JSON" } });
        result = await pollReport(r.reportId);
      } else if (name === "get_search_term_report") {
        const r = await adsPost("/reporting/reports", { name: "Search term report", startDate: args.startDate, endDate: args.endDate, configuration: { adProduct: "SPONSORED_PRODUCTS", groupBy: ["searchTerm"], columns: ["startDate","endDate","campaignId","adGroupId","keywordId","keyword","matchType","searchTerm","impressions","clicks","cost","purchases14d","sales14d"], reportTypeId: "spSearchTerm", timeUnit: "SUMMARY", format: "GZIP_JSON" } });
        result = await pollReport(r.reportId);

      } else if (name === "get_advertised_product_report") {
        // ASIN-level performance - joins spend/sales/clicks to the actual product advertised.
        // Needed for SKU-level, category, and ASP-band analysis that campaign/keyword reports can't provide.
        const r = await adsPost("/reporting/reports", { name: "Advertised product report", startDate: args.startDate, endDate: args.endDate, configuration: { adProduct: "SPONSORED_PRODUCTS", groupBy: ["advertiser"], columns: ["startDate","endDate","campaignId","campaignName","adGroupId","adGroupName","advertisedAsin","advertisedSku","impressions","clicks","cost","purchases14d","sales14d","unitsSoldClicks14d"], reportTypeId: "spAdvertisedProduct", timeUnit: "SUMMARY", format: "GZIP_JSON" } });
        result = await pollReport(r.reportId);

      } else if (name === "get_report_by_id") {
        // Checks a specific report's status. If already COMPLETED, fetches its data
        // directly - never triggers a new report generation.
        const status = await adsGet(`/reporting/reports/${args.reportId}`);
        if (status.status === "COMPLETED" && status.url) {
          const data = await fetchReportFile(status.url);
          result = { reportStatus: status.status, data };
        } else {
          result = { reportStatus: status.status, detail: status };
        }

      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}\n${err.response?.data ? JSON.stringify(err.response.data) : ""}` }], isError: true };
    }
  });

  return server;
}

const app = express();
app.use(express.json());

// SSE transport (for Claude Desktop)
const sseTransports = {};
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  sseTransports[transport.sessionId] = transport;
  res.on("close", () => delete sseTransports[transport.sessionId]);
  const server = createServer();
  await server.connect(transport);
});
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sseTransports[sessionId];
  if (!transport) return res.status(404).json({ error: "Session not found" });
  await transport.handlePostMessage(req, res);
});

// Streamable HTTP transport (for Claude.ai web)
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createServer();
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

app.get("/", (req, res) => res.json({ status: "Rubans Amazon Ads MCP server running", endpoints: ["/sse", "/mcp"] }));

app.listen(PORT, () => console.log(`Rubans Ads MCP server on port ${PORT}`));
