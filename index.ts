#!/usr/bin/env bun

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createInterface } from "readline/promises";

// --- Types ---

interface FieldConfig {
  id: string;
  options: Record<string, string>;
}

interface ProjectConfig {
  owner: string;
  number: number;
  id: string;
  repo: string;
  fields: Record<string, FieldConfig>;
  excludeStatuses?: string[];
}

interface Config {
  defaultOwner: string;
  projects: Record<string, ProjectConfig>;
}

// --- Paths ---

const CONFIG_DIR = join(homedir(), ".config", "ghp");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// --- Helpers ---

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

async function gh(args: string[], throwOnError = false): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    if (throwOnError) throw new Error(stderr.trim());
    die(`gh ${args.join(" ")} failed:\n${stderr.trim()}`);
  }
  return stdout.trim();
}

async function ghJSON(args: string[], throwOnError = false): Promise<any> {
  const out = await gh(args, throwOnError);
  return JSON.parse(out);
}

async function graphqlFields(owner: string, number: number): Promise<Record<string, FieldConfig>> {
  const query = `
    query($owner: String!, $number: Int!) {
      organization(login: $owner) {
        projectV2(number: $number) {
          fields(first: 100) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
                options { id name }
              }
              ... on ProjectV2IterationField {
                id
                name
              }
              ... on ProjectV2Field {
                id
                name
              }
            }
          }
        }
      }
    }
  `;

  const userQuery = query.replace("organization(login: $owner)", "user(login: $owner)");

  let data: any;
  try {
    data = await ghJSON([
      "api", "graphql",
      "-f", `query=${query}`,
      "-f", `owner=${owner}`,
      "-F", `number=${number}`,
    ], true);
  } catch {
    // Fallback: try as user instead of org
    data = await ghJSON([
      "api", "graphql",
      "-f", `query=${userQuery}`,
      "-f", `owner=${owner}`,
      "-F", `number=${number}`,
    ]);
  }

  const project = data.data?.organization?.projectV2 ?? data.data?.user?.projectV2;
  if (!project) die(`Could not find project #${number} for owner "${owner}"`);

  const fields: Record<string, FieldConfig> = {};
  for (const node of project.fields.nodes) {
    if (node.options) {
      const opts: Record<string, string> = {};
      for (const opt of node.options) {
        opts[opt.name] = opt.id;
      }
      fields[node.name] = { id: node.id, options: opts };
    }
  }
  return fields;
}

function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    die(`No config found. Run "gh p init" first.`);
  }
  const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  // Migrate old format: top-level "owner" → "defaultOwner" + per-project owner
  if (raw.owner && !raw.defaultOwner) {
    raw.defaultOwner = raw.owner;
    delete raw.owner;
    for (const proj of Object.values(raw.projects) as any[]) {
      if (!proj.owner) proj.owner = raw.defaultOwner;
    }
    saveConfig(raw);
  }
  return raw;
}

function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

function getProject(config: Config, alias: string): ProjectConfig {
  const proj = config.projects[alias];
  if (!proj) {
    const available = Object.keys(config.projects).join(", ");
    die(`Unknown project "${alias}". Available: ${available || "(none — run gh p init)"}`);
  }
  return proj;
}

async function ask(rl: any, question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` [${defaultVal}]` : "";
  const answer = await rl.question(`${question}${suffix}: `);
  return answer.trim() || defaultVal || "";
}

// --- Commands ---

async function cmdInit() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    // Load existing config or start fresh
    let config: Config;
    if (existsSync(CONFIG_FILE)) {
      config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      // Migrate old format: top-level owner → per-project owner
      if ((config as any).owner && !config.defaultOwner) {
        config.defaultOwner = (config as any).owner;
        delete (config as any).owner;
        for (const proj of Object.values(config.projects)) {
          if (!proj.owner) proj.owner = config.defaultOwner;
        }
      }
      console.log(`Existing config found. Adding projects to existing config.`);
    } else {
      config = { defaultOwner: "evolutionaryherbalism", projects: {} };
    }

    const owner = await ask(rl, "Owner (org or username)", config.defaultOwner);

    console.log(`\nFetching projects for "${owner}"...`);
    const data = await ghJSON([
      "project", "list", "--owner", owner, "--format", "json", "--limit", "100",
    ]);

    for (const proj of data.projects) {
      console.log(`\n  #${proj.number}: ${proj.title}`);
      const alias = await ask(rl, "  Alias (blank to skip)");
      if (!alias) continue;

      const repo = await ask(rl, "  Default repo name", alias);

      console.log(`  Fetching fields for #${proj.number}...`);
      const fields = await graphqlFields(owner, proj.number);

      const statusOptions = fields["Status"] ? Object.keys(fields["Status"].options) : [];
      const excludeDefault = statusOptions.filter((s) => s === "Done");
      const excludeInput = await ask(rl, "  Exclude statuses by default (comma-separated)", excludeDefault.join(", "));
      const excludeStatuses = excludeInput ? excludeInput.split(",").map((s) => s.trim()).filter(Boolean) : [];

      config.projects[alias] = {
        owner,
        number: proj.number,
        id: proj.id,
        repo,
        fields,
        ...(excludeStatuses.length > 0 ? { excludeStatuses } : {}),
      };

      const fieldNames = Object.keys(fields);
      if (fieldNames.length > 0) {
        console.log(`  Found fields: ${fieldNames.join(", ")}`);
      }
    }

    saveConfig(config);
    console.log(`\nConfig written to ${CONFIG_FILE}`);
  } finally {
    rl.close();
  }
}

async function cmdSync() {
  const config = loadConfig();
  const interactive = process.stdin.isTTY === true;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;

  async function prompt(question: string): Promise<string> {
    if (!rl) return '';
    return (await rl.question(question)).trim();
  }

  try {
    const byOwner = new Map<string, [string, ProjectConfig][]>();
    for (const [alias, proj] of Object.entries(config.projects)) {
      const owner = proj.owner ?? config.defaultOwner;
      if (!byOwner.has(owner)) byOwner.set(owner, []);
      byOwner.get(owner)!.push([alias, proj]);
    }

    const toRemove: string[] = [];
    const toRename: [string, string][] = [];

    for (const [owner, entries] of byOwner) {
      console.log(`Syncing projects for "${owner}"...`);

      const data = await ghJSON([
        "project", "list", "--owner", owner, "--format", "json", "--limit", "100",
      ]);

      const latest = new Map<number, any>();
      for (const proj of data.projects) {
        latest.set(proj.number, proj);
      }

      for (const [alias, proj] of entries) {
        const fresh = latest.get(proj.number);
        if (!fresh) {
          if (interactive) {
            const answer = (await prompt(`  Project #${proj.number} ("${alias}") no longer exists remotely. Remove from config? [y/N] `)).toLowerCase();
            if (answer === 'y') {
              toRemove.push(alias);
              console.log(`  Removed "${alias}"`);
            } else {
              console.log(`  Kept stale config for "${alias}"`);
            }
          } else {
            console.log(`  Warning: project #${proj.number} ("${alias}") not found, keeping stale config`);
          }
          continue;
        }

        proj.id = fresh.id;

        if (fresh.title !== alias && interactive) {
          const answer = await prompt(`  Project #${proj.number} is named "${fresh.title}" but alias is "${alias}". New alias (blank to keep): `);
          if (answer) toRename.push([alias, answer]);
        } else if (fresh.title !== alias) {
          console.log(`  Note: project #${proj.number} is named "${fresh.title}" but alias is "${alias}" (run interactively to rename)`);
        }

        console.log(`  Refreshing fields for "${alias}" (#${proj.number})...`);
        proj.fields = await graphqlFields(owner, proj.number);
      }
    }

    for (const alias of toRemove) {
      delete config.projects[alias];
    }

    for (const [oldAlias, newAlias] of toRename) {
      config.projects[newAlias] = config.projects[oldAlias];
      delete config.projects[oldAlias];
      console.log(`  Renamed alias "${oldAlias}" → "${newAlias}"`);
    }

    saveConfig(config);
    console.log(`Config updated: ${CONFIG_FILE}`);
  } finally {
    rl?.close();
  }
}

function resolveFieldOption(proj: ProjectConfig, fieldName: string, optionName: string): { field: FieldConfig; optionId: string } {
  const field = proj.fields[fieldName];
  if (!field) die(`No "${fieldName}" field found. Run "gh p sync".`);
  const optionId = field.options[optionName];
  if (!optionId) {
    const available = Object.keys(field.options).join(", ");
    die(`Unknown ${fieldName.toLowerCase()} "${optionName}". Available: ${available}`);
  }
  return { field, optionId };
}

async function setItemField(proj: ProjectConfig, itemId: string, fieldId: string, optionId: string) {
  await gh([
    "project", "item-edit",
    "--id", itemId,
    "--project-id", proj.id,
    "--field-id", fieldId,
    "--single-select-option-id", optionId,
  ]);
}

async function findItemId(proj: ProjectConfig, owner: string, issueNum: string): Promise<string> {
  const num = parseInt(issueNum, 10);
  const repoFullName = `${owner}/${proj.repo}`;
  // Retry: item-list can lag immediately after item-add
  const delays = [0, 500, 1500, 3000];
  for (const delay of delays) {
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    const data = await ghJSON([
      "project", "item-list", String(proj.number),
      "--owner", owner,
      "--format", "json",
      "--limit", "500",
    ]);
    const item = data.items.find(
      (i: any) => i.content?.number === num && i.content?.repository === repoFullName
    );
    if (item) return item.id;
  }
  die(`Issue #${issueNum} not found in project "${proj.repo}". Did you add it first?`);
}

async function cmdAdd(alias: string, issueNum: string, statusName?: string, priorityName?: string) {
  const config = loadConfig();
  const proj = getProject(config, alias);
  const owner = proj.owner ?? config.defaultOwner;
  const url = `https://github.com/${owner}/${proj.repo}/issues/${issueNum}`;

  const result = await ghJSON([
    "project", "item-add", String(proj.number),
    "--owner", owner,
    "--url", url,
    "--format", "json",
  ]);

  console.log(`Added issue #${issueNum} to "${alias}" (item ${result.id})`);

  if (statusName) {
    const { field, optionId } = resolveFieldOption(proj, "Status", statusName);
    await setItemField(proj, result.id, field.id, optionId);
    console.log(`Set #${issueNum} status to "${statusName}"`);
  }
  if (priorityName) {
    const { field, optionId } = resolveFieldOption(proj, "Priority", priorityName);
    await setItemField(proj, result.id, field.id, optionId);
    console.log(`Set #${issueNum} priority to "${priorityName}"`);
  }
}

async function cmdStatus(alias: string, issueNum: string, statusName: string) {
  const config = loadConfig();
  const proj = getProject(config, alias);
  const owner = proj.owner ?? config.defaultOwner;
  const { field, optionId } = resolveFieldOption(proj, "Status", statusName);
  const itemId = await findItemId(proj, owner, issueNum);
  await setItemField(proj, itemId, field.id, optionId);
  console.log(`Set #${issueNum} status to "${statusName}"`);
}

async function cmdPriority(alias: string, issueNum: string, priorityName: string) {
  const config = loadConfig();
  const proj = getProject(config, alias);
  const owner = proj.owner ?? config.defaultOwner;
  const { field, optionId } = resolveFieldOption(proj, "Priority", priorityName);
  const itemId = await findItemId(proj, owner, issueNum);
  await setItemField(proj, itemId, field.id, optionId);
  console.log(`Set #${issueNum} priority to "${priorityName}"`);
}

interface ItemDetails {
  status: string;
  updatedAt: string;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

async function fetchItemDetails(owner: string, projectNumber: number): Promise<Map<number, ItemDetails>> {
  const query = `
    query($owner: String!, $number: Int!, $cursor: String) {
      user(login: $owner) {
        projectV2(number: $number) {
          items(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              content {
                ... on Issue { number updatedAt }
                ... on PullRequest { number updatedAt }
              }
              fieldValues(first: 20) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
                }
              }
            }
          }
        }
      }
    }
  `;

  const detailsMap = new Map<number, ItemDetails>();
  let cursor: string | null = null;

  while (true) {
    const args = [
      "api", "graphql",
      "-f", `query=${query}`,
      "-f", `owner=${owner}`,
      "-F", `number=${projectNumber}`,
    ];
    if (cursor) args.push("-f", `cursor=${cursor}`);

    const data = await ghJSON(args);
    const items = data.data?.user?.projectV2?.items;
    if (!items) break;

    for (const node of items.nodes) {
      const num = node.content?.number;
      if (!num) continue;
      let status = "";
      for (const fv of node.fieldValues.nodes) {
        if (fv.field?.name === "Status" && fv.name) {
          status = fv.name;
        }
      }
      detailsMap.set(num, {
        status,
        updatedAt: node.content?.updatedAt ?? "",
      });
    }

    if (!items.pageInfo.hasNextPage) break;
    cursor = items.pageInfo.endCursor;
  }

  return detailsMap;
}

type SortKey = "updated" | "created" | "number";

function parseSince(value: string): Date {
  const match = value.match(/^(\d+)\s*(d|w|m|h)$/i);
  if (!match) die(`Invalid --since value "${value}". Use: 1d, 4d, 1w, 2w, 1m, 6h`);
  const n = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const now = new Date();
  if (unit === "h") now.setHours(now.getHours() - n);
  else if (unit === "d") now.setDate(now.getDate() - n);
  else if (unit === "w") now.setDate(now.getDate() - n * 7);
  else if (unit === "m") now.setMonth(now.getMonth() - n);
  return now;
}

async function cmdList(alias: string, statusFilter?: string, verbose = true, all = false, sort: SortKey = "updated", since?: Date) {
  const config = loadConfig();
  const proj = getProject(config, alias);
  const owner = proj.owner ?? config.defaultOwner;
  const excluded = all ? [] : (proj.excludeStatuses ?? []);

  const data = await ghJSON([
    "project", "item-list", String(proj.number),
    "--owner", owner,
    "--format", "json",
    "--limit", "500",
  ]);

  let items: any[] = data.items.filter((i: any) => i.content?.number != null);

  const needsDetails = verbose || statusFilter || excluded.length > 0 || sort === "updated" || since;
  const detailsMap = needsDetails
    ? await fetchItemDetails(owner, proj.number)
    : new Map<number, ItemDetails>();

  const rows: { num: number; title: string; status: string; updatedAt: string }[] = [];
  for (const item of items) {
    const num = item.content.number;
    const title = item.content.title;
    const details = detailsMap.get(num);
    const status = details?.status ?? "";
    const updatedAt = details?.updatedAt ?? "";

    if (statusFilter && status.toLowerCase() !== statusFilter.toLowerCase()) continue;
    if (excluded.some((s) => s.toLowerCase() === status.toLowerCase())) continue;
    if (since && (!updatedAt || new Date(updatedAt) < since)) continue;
    rows.push({ num, title, status, updatedAt });
  }

  if (rows.length === 0) {
    const hint = !all && excluded.length > 0 ? ` (use --all to include ${excluded.join(", ")})` : "";
    console.log(statusFilter ? `No items with status "${statusFilter}"` : `No items found${hint}`);
    return;
  }

  if (sort === "updated") {
    rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  } else if (sort === "created") {
    rows.sort((a, b) => b.num - a.num);
  } else {
    rows.sort((a, b) => a.num - b.num);
  }

  const numWidth = Math.max(1, ...rows.map((r) => String(r.num).length));
  const titleWidth = Math.max(5, ...rows.map((r) => r.title.length));

  for (const r of rows) {
    const n = String(r.num).padStart(numWidth);
    const t = r.title.padEnd(titleWidth);
    const parts = [r.status, r.updatedAt ? relativeTime(r.updatedAt) : ""].filter(Boolean);
    const suffix = verbose && parts.length ? `  ${parts.join("  ")}` : "";
    console.log(`  #${n}  ${t}${suffix}`);
  }
}

async function cmdStatuses(alias: string) {
  const config = loadConfig();
  const proj = getProject(config, alias);

  const statusField = proj.fields["Status"];
  if (!statusField) die(`No "Status" field found for "${alias}".`);

  console.log(`Status options for "${alias}":`);
  for (const name of Object.keys(statusField.options)) {
    console.log(`  ${name}`);
  }
}

// --- Usage ---

function usage() {
  console.log(`Usage: gh p <command>

Commands:
  init                                                Interactive setup — add projects from any owner
  sync                                                Refresh cached IDs and field options from GitHub
  add <alias> <issue> [--status <s>] [--priority <p>] Add an issue to a project (optionally set status/priority)
  status <alias> <issue> <name>                       Set the status of an issue
  priority <alias> <issue> <name>                     Set the priority of an issue
  list <alias> [-b] [--all] [--status <s>] [--sort <key>] [--since <age>]
                                                List items (-b brief: number+title only; sort: updated|created|number; since: 1d, 4d, 1w)
  statuses <alias>                                    Show available status options`);
}

function takeFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const val = args[idx + 1];
  args.splice(idx, 2);
  return val;
}

// --- Main ---

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "init":
    await cmdInit();
    break;
  case "sync":
    await cmdSync();
    break;
  case "add": {
    const addArgs = [...args];
    const statusFlag = takeFlag(addArgs, "--status");
    const priorityFlag = takeFlag(addArgs, "--priority");
    if (addArgs.length < 2) die("Usage: gh p add <alias> <issue-number> [--status <name>] [--priority <name>]");
    await cmdAdd(addArgs[0], addArgs[1], statusFlag, priorityFlag);
    break;
  }
  case "status":
    if (args.length < 3) die("Usage: gh p status <alias> <issue-number> <status-name>");
    await cmdStatus(args[0], args[1], args.slice(2).join(" "));
    break;
  case "priority":
    if (args.length < 3) die("Usage: gh p priority <alias> <issue-number> <P0|P1|P2>");
    await cmdPriority(args[0], args[1], args.slice(2).join(" "));
    break;
  case "list": {
    if (args.length < 1) die("Usage: gh p list <alias> [-b] [--all] [--status <s>] [--sort <key>] [--since <age>]");
    const listArgs = [...args];
    const brief = listArgs.includes("-b") || listArgs.includes("--brief");
    const verbose = !brief;
    const all = listArgs.includes("--all");
    const sortFlag = takeFlag(listArgs, "--sort") as SortKey | undefined;
    const sort: SortKey = sortFlag && ["updated", "created", "number"].includes(sortFlag) ? sortFlag : "updated";
    const sinceFlag = takeFlag(listArgs, "--since");
    const since = sinceFlag ? parseSince(sinceFlag) : undefined;
    const filtered = listArgs.filter(a => a !== "-b" && a !== "--brief" && a !== "--all");
    const statusIdx = filtered.indexOf("--status");
    const filter = statusIdx >= 0 ? filtered.slice(statusIdx + 1).join(" ") : undefined;
    await cmdList(filtered[0], filter, verbose, all, sort, since);
    break;
  }
  case "statuses":
    if (args.length < 1) die("Usage: gh p statuses <alias>");
    await cmdStatuses(args[0]);
    break;
  default:
    usage();
    if (cmd && cmd !== "--help" && cmd !== "-h" && cmd !== "help") process.exit(1);
    break;
}
