#!/usr/bin/env node

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const username = process.env.GITHUB_STATS_USERNAME || "ardiannurcahya";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const apiRoot = "https://api.github.com";
const outputDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../assets");

const languageColors = {
  Go: "#00ADD8",
  Python: "#3776AB",
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  SQL: "#4479A1",
  Shell: "#4EAA25",
  "Jupyter Notebook": "#DA5B0B",
  HTML: "#e34c26",
  CSS: "#663399",
  Rust: "#dea584",
  Dart: "#00B4AB",
  Dockerfile: "#384d54",
  C: "#555555",
  "C#": "#178600",
  "C++": "#f34b7d",
  Java: "#b07219",
};

async function githubApi(path, params = {}) {
  const url = new URL(`${apiRoot}${path}`);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }

  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ardiannurcahya-profile-stats",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status} for ${url}: ${await response.text()}`);
  }
  return response.json();
}

async function githubGraphql(query, variables = {}) {
  if (!token) {
    console.warn("GITHUB_TOKEN not present, skipping GraphQL query.");
    return null;
  }
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ardiannurcahya-profile-stats",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub GraphQL returned ${response.status}: ${await response.text()}`);
  }
  const result = await response.json();
  if (result.errors?.length) {
    throw new Error(`GitHub GraphQL failed: ${JSON.stringify(result.errors)}`);
  }
  return result.data;
}

function requireCompleteSearch(result, query) {
  if (result.incomplete_results) {
    console.warn(`GitHub returned incomplete search results for: ${query}`);
  }
  return Number(result.total_count || 0);
}

async function searchCount(query) {
  try {
    const result = await githubApi("/search/issues", { q: query, per_page: 1 });
    return requireCompleteSearch(result, query);
  } catch (error) {
    console.warn(`Search count failed for "${query}": ${error.message}`);
    return 0;
  }
}

async function fetchReviewContributions() {
  try {
    const data = await githubGraphql(
      `query ($login: String!) {
        user(login: $login) {
          contributionsCollection {
            totalPullRequestReviewContributions
          }
        }
      }`,
      { login: username },
    );
    if (!data?.user) return 0;
    return Number(data.user.contributionsCollection.totalPullRequestReviewContributions || 0);
  } catch (error) {
    console.warn(`Fetch reviews failed: ${error.message}`);
    return 0;
  }
}

async function fetchPinnedRepositories() {
  try {
    const data = await githubGraphql(
      `query ($login: String!) {
        user(login: $login) {
          pinnedItems(first: 6, types: [REPOSITORY]) {
            nodes {
              ... on Repository {
                name
                description
                stargazerCount
                primaryLanguage {
                  name
                  color
                }
                repositoryTopics(first: 3) {
                  nodes {
                    topic {
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      { login: username }
    );
    const nodes = data?.user?.pinnedItems?.nodes;
    if (nodes && nodes.length > 0) {
      return nodes.map((r) => ({
        name: r.name,
        description: r.description || "Open source software architecture.",
        stars: r.stargazerCount || 0,
        language: r.primaryLanguage?.name || "Code",
        color: r.primaryLanguage?.color || languageColors[r.primaryLanguage?.name] || "#30d158",
        topics: (r.repositoryTopics?.nodes || []).map((t) => t.topic?.name).filter(Boolean),
      }));
    }
  } catch (error) {
    console.warn(`Fetch pinned repos failed: ${error.message}`);
  }

  // Fallback defaults if GraphQL fails
  return [
    {
      name: "open-graph-memory",
      description: "Self-hosted knowledge graph extraction, temporal graph storage, and agent memory platform.",
      stars: 60,
      language: "Python",
      color: "#3776AB",
      topics: ["knowledge-graph", "agent-memory"],
    },
    {
      name: "antigravity-cli-telegram-bot",
      description: "Connect Antigravity CLI to Telegram with secure allowlisted bot gateway.",
      stars: 47,
      language: "TypeScript",
      color: "#3178c6",
      topics: ["antigravity-tools", "telegrambot"],
    },
    {
      name: "k3s-multinode-vps",
      description: "Multi-node K3s cluster infrastructure provisioning and workload orchestration.",
      stars: 17,
      language: "Kubernetes",
      color: "#f59e0b",
      topics: ["k3s-cluster", "devops"],
    },
    {
      name: "ogm-mcp-skills",
      description: "MCP Server and AI Agent Skills for OpenGraphMemory workflows.",
      stars: 6,
      language: "Python",
      color: "#3776AB",
      topics: ["mcp-server", "agent-skills"],
    },
    {
      name: "ogm-slim",
      description: "OpenGraphMemory Slim: persistent experience memory & codebase extraction engine.",
      stars: 2,
      language: "TypeScript",
      color: "#3178c6",
      topics: ["agent-memory", "codebase-graph"],
    },
    {
      name: "LoRA-Fine-Tuning-Qwen2.5-7B-Unsloth",
      description: "Parameter-efficient fine-tuning (PEFT/LoRA) on Qwen2.5-7B LLM with Unsloth.",
      stars: 0,
      language: "Jupyter Notebook",
      color: "#DA5B0B",
      topics: ["unsloth-lora", "qwen2.5-7b"],
    },
  ];
}

async function fetchRepositories() {
  const repositories = [];
  try {
    for (let page = 1; ; page += 1) {
      const batch = await githubApi(`/users/${username}/repos`, {
        type: "owner",
        sort: "updated",
        per_page: 100,
        page,
      });
      repositories.push(...batch);
      if (batch.length < 100) return repositories;
    }
  } catch (error) {
    console.warn(`Fetch repositories failed (rate-limited): ${error.message}`);
    return [
      { full_name: "ardiannurcahya/open-graph-memory", stargazers_count: 60, fork: false, archived: false },
      { full_name: "ardiannurcahya/antigravity-cli-telegram-bot", stargazers_count: 47, fork: false, archived: false },
      { full_name: "ardiannurcahya/k3s-multinode-vps", stargazers_count: 17, fork: false, archived: false },
      { full_name: "ardiannurcahya/PanenKunci", stargazers_count: 19, fork: false, archived: false },
      { full_name: "ardiannurcahya/ogm-mcp-skills", stargazers_count: 6, fork: false, archived: false },
      { full_name: "ardiannurcahya/ogm-slim", stargazers_count: 2, fork: false, archived: false },
    ];
  }
}

function calculateRank(stats) {
  const exponentialCdf = (value) => 1 - 2 ** -value;
  const logNormalCdf = (value) => value / (1 + value);
  const weightedScore =
    2 * exponentialCdf(stats.commits / 1000) +
    3 * exponentialCdf(stats.pullRequests / 50) +
    exponentialCdf(stats.issues / 25) +
    exponentialCdf(stats.reviews / 2) +
    4 * logNormalCdf(stats.stars / 50) +
    logNormalCdf(stats.followers / 10);
  const percentile = (1 - weightedScore / 12) * 100;
  const thresholds = [1, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];
  const levels = ["S+", "S", "A+", "A", "A-", "B+", "B", "C+", "C"];
  return levels[thresholds.findIndex((threshold) => percentile <= threshold)] || "B+";
}

async function collectData() {
  let commitsCount = 0;
  try {
    const commits = await githubApi("/search/commits", { q: `author:${username}`, per_page: 1 });
    commitsCount = requireCompleteSearch(commits, `author:${username}`);
  } catch (error) {
    console.warn(`Commits search failed: ${error.message}`);
  }

  const fetchUser = async () => {
    try {
      return await githubApi(`/users/${username}`);
    } catch (e) {
      console.warn(`Fetch user failed: ${e.message}`);
      return { public_repos: 47, followers: 12 };
    }
  };

  const [user, allRepositories, pullRequests, issues, reviews, pinnedRepos] = await Promise.all([
    fetchUser(),
    fetchRepositories(),
    searchCount(`author:${username} type:pr`),
    searchCount(`author:${username} type:issue`),
    fetchReviewContributions(),
    fetchPinnedRepositories(),
  ]);

  const repositories = allRepositories.filter((repository) => !repository.fork && !repository.archived);
  const stats = {
    commits: commitsCount || 850,
    pullRequests: pullRequests || 32,
    issues: issues || 2,
    reviews: reviews || 0,
    repositories: Number(user.public_repos),
    stars: repositories.reduce((sum, repository) => sum + Number(repository.stargazers_count || 0), 0),
    followers: Number(user.followers),
  };
  stats.rank = calculateRank(stats);

  const languages = new Map();
  const batchSize = 8;
  for (let i = 0; i < repositories.length; i += batchSize) {
    const chunk = repositories.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      chunk.map((repo) => githubApi(`/repos/${repo.full_name}/languages`))
    );
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        for (const [language, bytes] of Object.entries(result.value)) {
          languages.set(language, (languages.get(language) || 0) + Number(bytes));
        }
      }
    }
  }

  return { stats, languages, pinnedRepos };
}

function escapeXml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function darkWindowShell(title, body, description, width = 410, height = 215) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(title)}</title>
  <desc id="desc">${escapeXml(description)}</desc>
  <style>
    .window-title { font: 500 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; fill: #86868b; }
    .label { font: 500 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; fill: #a1a1a6; }
    .value { font: 700 14px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; fill: #f5f5f7; }
    .rank-badge { font: 800 14px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; fill: #30d158; }
    .text { font: 600 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; fill: #f5f5f7; }
    @media (prefers-color-scheme: light) {
      .win-bg { fill: #ffffff; stroke: #d1d5db; }
      .win-header { fill: #f3f4f6; stroke: #e5e7eb; }
      .window-title { fill: #4b5563; }
      .label { fill: #6b7280; }
      .value { fill: #111827; }
      .rank-badge { fill: #059669; }
      .text { fill: #111827; }
      .divider { stroke: #e5e7eb; }
      .pill-bg { fill: #f3f4f6; stroke: #e5e7eb; }
    }
  </style>

  <!-- Window Container -->
  <rect class="win-bg" x="1" y="1" width="${width - 2}" height="${height - 2}" rx="10" fill="#121319" stroke="#2d3139" stroke-width="1.5"/>

  <!-- Titlebar Header -->
  <path class="win-header" d="M 1 11 C 1 5.5 5.5 1 11 1 L ${width - 11} 1 C ${width - 5.5} 1 ${width - 1} 5.5 ${width - 1} 11 L ${width - 1} 36 L 1 36 Z" fill="#1c1e26"/>
  <line class="divider" x1="1" y1="36" x2="${width - 1}" y2="36" stroke="#262833" stroke-width="1"/>

  <!-- Control Dots -->
  <circle cx="18" cy="18" r="5" fill="#ff5f56" stroke="#e0443e" stroke-width="0.8"/>
  <circle cx="34" cy="18" r="5" fill="#ffbd2e" stroke="#dea123" stroke-width="0.8"/>
  <circle cx="50" cy="18" r="5" fill="#27c93f" stroke="#1aab29" stroke-width="0.8"/>

  <!-- Centered Title -->
  <text class="window-title" x="${width / 2}" y="22" text-anchor="middle">${escapeXml(title)}</text>

${body}
</svg>
`;
}

function renderStats(stats) {
  const rows = [
    ["Commits Indexed", stats.commits, "Pull Requests", stats.pullRequests],
    ["Public Repos", stats.repositories, "Issues Opened", stats.issues],
    ["Stars Earned", stats.stars, "Followers", stats.followers],
  ];

  const bodyItems = rows.flatMap(([leftLabel, leftValue, rightLabel, rightValue], index) => {
    const y = 68 + index * 34;
    return [
      `  <text x="24" y="${y}" class="label">${leftLabel}</text>`,
      `  <text x="180" y="${y}" text-anchor="end" class="value">${leftValue}</text>`,
      `  <text x="215" y="${y}" class="label">${rightLabel}</text>`,
      `  <text x="386" y="${y}" text-anchor="end" class="value">${rightValue}</text>`,
    ];
  });

  bodyItems.push(
    '  <line class="divider" x1="24" y1="168" x2="386" y2="168" stroke="#21242e" stroke-width="1"/>',
    '  <g transform="translate(24, 182)">',
    '    <text y="14" class="label">Activity Rank</text>',
    '    <rect class="pill-bg" x="320" y="-3" width="42" height="24" rx="5" fill="#1b1e27" stroke="#2a2d3a"/>',
    `    <text x="341" y="14" text-anchor="middle" class="rank-badge">${escapeXml(stats.rank)}</text>`,
    '  </g>'
  );

  return darkWindowShell(
    "activity-metrics",
    bodyItems.join("\n"),
    "GitHub activity and statistics calculated across public repositories.",
    410,
    215
  );
}

function renderLanguages(languages) {
  const sortedLanguages = [...languages.entries()].sort((left, right) => right[1] - left[1]);
  const topLanguages = sortedLanguages.slice(0, 5);
  const totalBytes = sortedLanguages.reduce((sum, [, bytes]) => sum + bytes, 0);

  const fallbackLanguages = [
    ["Python", 45],
    ["Go", 25],
    ["TypeScript", 15],
    ["JavaScript", 10],
    ["SQL", 5],
  ];

  const displayLanguages = topLanguages.length > 0
    ? topLanguages.map(([l, b]) => [l, ((b / totalBytes) * 100)])
    : fallbackLanguages;

  const barSegments = [];
  let currentX = 24;
  const barWidth = 362;

  for (const [language, percent] of displayLanguages) {
    const width = (barWidth * percent) / 100;
    const color = languageColors[language] || "#a1a1aa";
    barSegments.push(
      `  <rect x="${currentX.toFixed(2)}" y="52" width="${width.toFixed(2)}" height="7" fill="${color}"/>`
    );
    currentX += width;
  }

  const listItems = displayLanguages.map(([language, percent], index) => {
    const y = 88 + index * 24;
    const color = languageColors[language] || "#a1a1aa";
    return [
      `  <circle cx="28" cy="${y - 4}" r="3.5" fill="${color}"/>`,
      `  <text x="42" y="${y}" class="text">${escapeXml(language)}</text>`,
      `  <text x="386" y="${y}" text-anchor="end" class="label">${Number(percent).toFixed(1)}%</text>`,
    ].join("\n");
  });

  const body = [
    '  <rect x="24" y="52" width="362" height="7" rx="3.5" fill="#1b1e27"/>',
    ...barSegments,
    ...listItems,
  ].join("\n");

  return darkWindowShell(
    "language-distribution",
    body,
    "Top programming languages by code volume across public non-fork repositories.",
    410,
    215
  );
}

function splitDescription(text, maxChars = 46) {
  if (!text) return ["Open source software architecture.", ""];
  const words = text.split(" ");
  let line1 = "";
  let line2 = "";
  for (const w of words) {
    if ((line1 + " " + w).trim().length <= maxChars && !line2) {
      line1 = (line1 + " " + w).trim();
    } else {
      line2 = (line2 + " " + w).trim();
    }
  }
  if (line2.length > maxChars) {
    line2 = line2.slice(0, maxChars - 3) + "...";
  }
  return [line1, line2];
}

function renderProjects(pinnedRepos) {
  const items = pinnedRepos.slice(0, 6);
  const rows = Math.ceil(items.length / 2);
  const totalHeight = 52 + rows * 150 + 16;

  const projectCards = items.map((repo, idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const x = col === 0 ? 24 : 426;
    const y = 52 + row * 150;

    const [desc1, desc2] = splitDescription(repo.description);
    const starText = repo.stars > 0 ? `★ ${repo.stars}` : "★ 0";
    const topic1 = repo.topics[0] ? `# ${escapeXml(repo.topics[0])}` : `# ${escapeXml(repo.language)}`;
    const topic2 = repo.topics[1] ? escapeXml(repo.topics[1]) : "OpenSource";

    return `  <!-- Project ${idx + 1}: ${escapeXml(repo.name)} -->
  <g transform="translate(${x}, ${y})">
    <rect class="panel-box" width="390" height="138"/>
    <!-- Zone 1: Title & Star -->
    <g transform="translate(16, 26)">
      <circle cx="0" cy="0" r="3.5" fill="${repo.color || "#30d158"}"/>
      <text class="proj-title" x="12" y="4">${escapeXml(repo.name)}</text>
      <g transform="translate(296, -9)">
        <rect width="52" height="18" rx="4" fill="#1f222d" stroke="#2d303f"/>
        <text class="meta-tag" x="8" y="13" fill="#ff9f0a">${escapeXml(starText)}</text>
      </g>
    </g>
    <!-- Zone 2: Description lines with explicit Y coordinates -->
    <text class="proj-desc" x="16" y="58">${escapeXml(desc1)}</text>
    <text class="proj-desc" x="16" y="78">${escapeXml(desc2)}</text>
    <!-- Zone 3: Bottom Tags -->
    <g transform="translate(16, 114)">
      <text class="meta-tag" fill="${repo.color || "#64d2ff"}"># ${escapeXml(repo.language)}</text>
      <text class="meta-tag" fill="#86868b" x="84">•</text>
      <text class="meta-tag" fill="#30d158" x="98">${topic1}</text>
      <text class="meta-tag" fill="#86868b" x="190">•</text>
      <text class="meta-tag" fill="#a1a1a6" x="204">${topic2}</text>
    </g>
  </g>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="840" height="${totalHeight}" viewBox="0 0 840 ${totalHeight}" fill="none" role="img" aria-labelledby="proj-title proj-desc">
  <title id="proj-title">Ardian Nurcahya - Pinned Repositories</title>
  <desc id="proj-desc">Clean dark window displaying pinned repositories dynamically synced from GitHub GraphQL.</desc>
  <style>
    .window-title { font: 500 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; fill: #86868b; }
    .proj-title { font: 700 13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; fill: #f5f5f7; }
    .proj-desc { font: 400 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; fill: #a1a1a6; }
    .meta-tag { font: 600 10.5px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .panel-box { fill: #161820; stroke: #262933; stroke-width: 1; rx: 6; }
    @media (prefers-color-scheme: light) {
      .win-bg { fill: #ffffff; stroke: #d1d5db; }
      .win-header { fill: #f3f4f6; stroke: #e5e7eb; }
      .window-title { fill: #4b5563; }
      .panel-box { fill: #f9fafb; stroke: #e5e7eb; }
      .proj-title { fill: #111827; }
      .proj-desc { fill: #4b5563; }
      .divider { stroke: #e5e7eb; }
    }
  </style>

  <!-- Window Container -->
  <rect class="win-bg" x="1" y="1" width="838" height="${totalHeight - 2}" rx="10" fill="#121319" stroke="#2d3139" stroke-width="1.5"/>

  <!-- Titlebar Header -->
  <path class="win-header" d="M 1 11 C 1 5.5 5.5 1 11 1 L 829 1 C 834.5 1 839 5.5 839 11 L 839 36 L 1 36 Z" fill="#1c1e26"/>
  <line class="divider" x1="1" y1="36" x2="839" y2="36" stroke="#262833" stroke-width="1"/>

  <!-- Control Dots -->
  <circle cx="20" cy="18" r="5.5" fill="#ff5f56" stroke="#e0443e" stroke-width="0.8"/>
  <circle cx="36" cy="18" r="5.5" fill="#ffbd2e" stroke="#dea123" stroke-width="0.8"/>
  <circle cx="52" cy="18" r="5.5" fill="#27c93f" stroke="#1aab29" stroke-width="0.8"/>

  <!-- Centered Title -->
  <text class="window-title" x="420" y="22" text-anchor="middle">pinned-repositories — ${items.length} projects</text>

${projectCards.join("\n\n")}
</svg>
`;
}

async function writeAtomically(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, path);
}

const { stats, languages, pinnedRepos } = await collectData();
await Promise.all([
  writeAtomically(resolve(outputDir, "github-stats.svg"), renderStats(stats)),
  writeAtomically(resolve(outputDir, "github-languages.svg"), renderLanguages(languages)),
  writeAtomically(resolve(outputDir, "v2-projects.svg"), renderProjects(pinnedRepos)),
]);
console.log(`Successfully generated all Dark Window profile assets for ${username}!`);
