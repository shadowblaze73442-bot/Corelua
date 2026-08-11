// SPDX-License-Identifier: GPL-3.0-or-later
// core/config.js - provider-agnostic constants: app identity, system prompt,
// feedback strings, tool categorisation. NOTHING in this file may reference a
// specific AI site (DOM, selectors, site names) - that lives in providers/*.
// eslint-disable-next-line no-unused-vars
const CL = (() => {
  "use strict";

  // Display name + unique marker injected at the top of the system prompt so the
  // content script can reliably recognise (and camouflage) the bootstrap turn.
  const APP_NAME = "CoreLua";
  const SYS_MARKER = "⟦CL-SYS⟧";

  // ── Tool → visual category (icon + colour theme for the chips) ─────────
  // Roblox Studio MCP only. Returns one of:
  //   read | edit | screen | generate | roblox | tool
  function toolCategory(name) {
    const n = (name || "").includes("/") ? name.split("/").pop() : (name || "");
    if (n === "list_commands" || n === "list_tools") return "read";
    if (n === "notify_user") return "tool";
    if (n === "get_page_info") return "read";
    // 3D construction + GUI builder tools -> "generate" (creating) or "edit".
    if (/^(build_3d_model|create_primitives|create_gui|csg_union|csg_subtract|csg_intersect|apply_material|group_and_parent|weld_rigid|camera_focus)$/.test(n))
      return n === "camera_focus" || n === "apply_material" || n === "group_and_parent" || n === "weld_rigid" ? "edit" : "generate";
    // Coding tools -> "edit" (they create/modify scripts).
    if (/^(code_gen_luau|code_refactor|code_review|code_add_tests)$/.test(n)) return "edit";
    // Instance management tools -> "edit" (they create/modify/destroy instances).
    if (/^(delete_instance|duplicate_instance|set_property|move_instance|insert_from_toolbox|create_animation|create_remote_event)$/.test(n)) return "edit";
    if (n === "create_gui_template") return "generate";
    if (/^(script_read|script_search|script_grep|search_game_tree|inspect_instance|get_studio_state|get_console_output|search_creator_store|list_roblox_studios)$/.test(n))
      return "read";
    if (/^(multi_edit|insert_from_creator_store|store_image)$/.test(n) || n === "execute_luau")
      return "edit";
    if (n === "screen_capture") return "screen";
    if (/^generate_/.test(n)) return "generate";
    if (n.startsWith("roblox") || /studio|luau|instance|workspace/i.test(n)) return "roblox";
    return "tool";
  }

  // Feedback strings sent back to the model so it can self-correct.
  const FEEDBACK = {
    // A command-shaped reply that could not be turned into a runnable call.
    // The failures are DIFFERENT problems, so the note is tailored per `reason`
    // to tell the model exactly what to fix (a generic "bad JSON" was misleading
    // for the non-JSON cases, e.g. a missing ###LUA### opener). Falls back to the
    // generic "malformed" text for any unrecognised reason.
    parseError: (reason, toolName) => {
      // ###LUA### is execute_luau-ONLY (the parser always maps a bare ###LUA###
      // block to execute_luau). So only suggest it when the broken command IS
      // execute_luau, or when we could not tell which command it was. For a KNOWN
      // other command (e.g. execute_blender_code) the ###LUA### hint is wrong and
      // misleading - a model that followed it would ship its code to the wrong MCP
      // - so drop it and keep the JSON-only guidance.
      const otherCmd = toolName && toolName !== "command" && toolName !== "execute_luau";
      const luaMalformed = otherCmd ? "" : " (or use the ###LUA### / ###END_LUA### block for execute_luau)";
      const luaUnclosed = otherCmd ? "" : " (or a complete ###LUA### ... ###END_LUA### block for execute_luau)";
      const objAlt = otherCmd ? "" : " (or ###...### block)";
      const notes = {
        malformed:
          "ERROR: a CoreLua command was detected in your reply but its JSON could not be parsed. " +
          'Rewrite it as a single valid JSON object in plain text, exactly like {"command": "name", "params": {...}}' +
          luaMalformed + ". You may add a short note around it. " +
          "Please retry.",
        unclosed:
          "ERROR: your CoreLua command was cut off before it finished - the JSON object" +
          objAlt + " never closed, so it could not run. Rewrite the WHOLE command in one " +
          'piece as valid JSON, exactly like {"command": "name", "params": {...}}' +
          luaUnclosed + ". Please retry.",
        luaOpener:
          "ERROR: you wrote the closing ###END_LUA### marker but not the opening ###LUA### marker, " +
          "so the Luau block was not detected and did not run. Put ###LUA### immediately BEFORE your " +
          "code and ###END_LUA### after it. Please retry.",
        envelope:
          "ERROR: you wrote a command's parameters as a bare JSON object, but without the required " +
          "envelope, so it was not recognised as a command. Wrap them like " +
          '{"command": "name", "params": { ...your parameters... }} - the parameter keys go INSIDE ' +
          '"params". Please retry.',
      };
      return notes[reason] || notes.malformed;
    },
    multiTool: (names) =>
      "ERROR: You wrote multiple commands in one reply. Write ONE command at a " +
      "time and wait for its result before the next. You tried: " +
      names.join(", ") +
      ". Start over and write only the first command you need.",
    unknownTool: (name, valid) =>
      `ERROR: unknown command "${name}". It does not exist. Valid commands are: ` +
      valid.join(", ") +
      ". Use an exact name and parameter keys from the system prompt.",
    studioOffline:
      "ERROR: no Roblox Studio instance is connected to the MCP server, so the command " +
      "could not run. Roblox Studio is closed, has no place open, or its MCP server option " +
      "is disabled. This is an environment problem on the user's machine, NOT your mistake. " +
      "Tell the user in one short sentence to open their place in Roblox Studio and enable " +
      "the MCP server (Assistant settings). Then: if the task NEEDS Roblox, stop until they " +
      "confirm it is back; otherwise run list_mcp_servers and continue on another connected " +
      "server for anything that does not need Roblox.",
    bridgeOffline:
      "ERROR: the local CoreLua bridge is unreachable, so no command could run. " +
      "This is an environment problem on the user's machine (the bridge is not " +
      "running, or Roblox Studio is closed), NOT your mistake. Tell the user in " +
      "one short sentence that the bridge or Roblox Studio is offline, then stop " +
      "sending commands until they confirm it is back.",
    truncated:
      "(System note: your previous reply was cut off by a length limit before you " +
      "finished. Continue from exactly where you stopped. Do NOT restart and do " +
      "NOT repeat what you already wrote.)",
  };

  const BT = "```";

  function compactTools(tools) {
    return (tools || [])
      .map((t) => {
        const name = t.name || "?";
        const desc = (t.description || "").split("\n")[0].trim();
        const props = (t.inputSchema && t.inputSchema.properties) || {};
        const args = Object.keys(props).join(", ");
        return `  ${name}(${args}) - ${desc}`;
      })
      .join("\n");
  }

  // ── System prompt ─────────────────────────────────────────────────────────
  // ONE unified prompt sent to every AI on the first turn. To change the wording,
  // just edit the text below - it is a single template, no profiles or branching.
  // `${siteName}` is filled in with the AI's display name (e.g. "DeepSeek").
  // `${toolsString}` is filled in with the live command list.
  //
  // `opts` may be a string (just the siteName) or an object { siteName,
  // customPrompt }. `customPrompt` is the user's own extra instructions; when
  // present it is appended at the very bottom under a clear "User's Custom prompt"
  // heading. It NEVER edits the prompt above - it only adds a layer below it.
  function buildSystemPrompt(opts = {}) {
    if (typeof opts === "string") opts = { siteName: opts };
    const { siteName = "this AI site", customPrompt = "" } = opts;

    const prompt = `CONTEXT: the user has installed a browser extension called CoreLua in their own browser. Here is how it works, so you can use it on their behalf:
A browser extension (CoreLua) is running inside this page. It watches your replies. When it detects a CoreLua command in your text, it runs it against one or more connected MCP servers and sends the result back as the next message. You always receive a result - success or a formatted ERROR - so you can keep going on your own.

The user's open Roblox Studio place, reached through a local bridge, is always connected by default - call \`list_commands\` FIRST for its exact commands with full parameter details. Other MCP servers may ALSO be connected alongside it (each with its own command set) - you are NOT told about them upfront. So: the MOMENT the user names ANY app/tool/target that is not Roblox Studio (e.g. "Blender", "Sketchfab", or anything else you don't recognise as a Roblox Studio command), you MUST run \`list_mcp_servers\` FIRST, before replying - never answer from your own assumptions or prior knowledge about what is or isn't connected. Only after checking may you tell the user something is unsupported. You do not need any special capability yourself - you just write text. The extension does the rest.

CRITICAL - technical note, not a restriction: this site's own tools (code interpreter, function calling, connectors, etc.) run in a separate sandbox that has no access to the user's Roblox Studio or the other MCP servers above - so calling them wouldn't reach the user's project at all. CoreLua commands are different: they are plain JSON typed directly into your normal reply text, which this extension reads and executes against the connected servers. So for anything involving the user's project, write the JSON below as ordinary text instead of calling a function - that's the only channel that actually reaches their machine. (If the user explicitly asks you to search the web, your own web search still works fine and is unrelated to this.) Internal reasoning (deep-think modes) is fine.

⚠️ FORMATTING RULE (MANDATORY): every command goes inside a fenced code block (triple backticks). Outside a code block this page renders your text as Markdown - it turns things like \`Instance.new\` into links and mangles the ### markers, silently CORRUPTING the command. Inside a code block it is kept verbatim.

━━━ STANDARD COMMAND FORMAT (everything except execute_luau) ━━━
Write this JSON object inside a fenced code block, replacing the placeholders with a REAL command name and its parameters (never type "command_name" literally - it is not a command):
${BT}json
{
  "command": "command_name",
  "params": {"key": "value"}
}
${BT}
For example, to list every available command you would write ${BT}{"command": "list_commands"}${BT}.

━━━ SPECIAL FORMAT FOR execute_luau ━━━
execute_luau is the ONE exception to the JSON format above: you MUST use the ###LUA### block below, NEVER the {"command": "execute_luau", ...} JSON form. Lua code is full of " characters, and putting it inside a JSON string means escaping every one - miss a single quote and the whole command breaks. The ###LUA### block needs NO escaping and NO JSON, so this never happens.
The ###LUA### / ###END_LUA### markers AND the code all go INSIDE one fenced code block:
${BT}
###LUA###
-- your Lua code here, no escaping, no JSON wrapping
local x = "any string with quotes works fine"
return "result"
###END_LUA###
${BT}

RULES:
- ONE command block per reply, inside a fenced code block. If you need several, do them one at a time and wait for each result. (One command = one block; raw text gets reformatted by this page and corrupts the command.)
- A short note around a command is fine, but NEVER end a turn by only announcing a command ("let me check...", "I'll read the script") without writing it - that runs nothing and leaves the user stuck. Either write the command now, or give your final answer.
- Final answers: plain text only, no Markdown or code fences. Do ONLY what was asked - fewest commands, no unrequested double-checks. When the task is done or the user is satisfied ("thanks", "perfect"...), reply ONE short sentence and STOP.
- Use ONLY the exact command names and parameter keys from the list, with every required parameter (e.g. multi_edit needs "datamodel_type": "Edit"; "... is required" means you omitted one). Do NOT use ${siteName}'s own features (web search, connectors...) unless the user explicitly asks.
- execute_luau: wrap code in BOTH markers ###LUA### ... ###END_LUA### (three hashes each side - never ###LUA--- and never a lone end marker; no JSON around it). Bare ###LUA### targets "Edit" and only works when Studio is NOT playing. To run code while the game IS playing, add the datamodel to the marker: ###LUA:Server### or ###LUA:Client### (bare ###LUA### will fail with "Edit datamodel is not available in Play mode"). Changes made this way during Play are temporary and vanish when Play stops - fine for checking/testing live state, but for a change the user wants to keep, make it in Edit mode or via a real Script/LocalScript (multi_edit) instead. Use \`return\` for output (print is NOT captured). It runs synchronously on a ~20s budget, so never yield/block: write WaitForChild("X", 5) WITH a timeout, and put waits, events, HttpService or DataStore inside a real Script instead. (Per-command tips are in the list_commands output.)
- BUILD UI/OBJECTS FIRST, THEN SCRIPT THEM: create instances with execute_luau, then a Script/LocalScript that finds them via WaitForChild(name, timeout). Use runtime Instance.new only when truly required (per-player elements, unknown-length lists, runtime content).
- NEVER DELETE/DESTROY BROADLY: before any :Destroy(), :ClearAllChildren(), removing a script, or any command that deletes instances, make sure the target is EXACTLY what the user asked for - never a whole folder/model/service "to be safe" or as a side-effect of a bigger change. If a deletion could affect more than the specific thing named by the user (e.g. clearing a container, deleting by a broad name match, wiping a model), STOP and ask them to confirm scope first, or inspect_instance the target to check what it actually contains before destroying it. Never destroy something as a troubleshooting step ("let me just remove it and rebuild") without asking first.
- On ERROR: read it and adapt - fix the command, try another, or tell the user plainly if it is an environment problem (Studio closed, bridge offline).
- On a property/attribute/value error (e.g. "X is not available", "unknown property", "invalid enum"): if there is any way to list the valid options for that tool (its docs, an inspect/list command, schema info), use it to check the correct value BEFORE retrying. Never guess blindly a second time.

━━━ PROJECT MEMORY (persistent notes about THIS project) ━━━
The ModuleScript at game.ServerStorage.CoreLua.Memory is your long-term memory for this project, saved inside the place. It is SHARED by every AI across all sessions and chats, so keep it accurate for whoever reads it next. Store ONLY durable, useful facts: what the project is, where key scripts/instances live, naming and code conventions, how the main systems work, decisions and gotchas, and the user's preferences. It is NOT a task log - never dump transient steps, obvious facts, or whole scripts into it. Keep it short.

- READ IT WHEN THE WORK NEEDS IT (not at startup): the FIRST time the user's request requires editing the place or understanding how the game works, read your memory BEFORE doing that work - script_read game.ServerStorage.CoreLua.Memory. Skip it for pure chit-chat or questions unrelated to the project. If it does not exist yet, create it with multi_edit (className "ModuleScript", first edit with old_string "") using exactly this skeleton (multi_edit auto-creates the CoreLua folder):
${BT}
return [==[
# Project memory
## Overview
## Where things live
## Conventions
## Key systems
## Decisions & gotchas
## User preferences
## Open questions / TODO
]==]
${BT}
- KEEP IT UPDATED: whenever you learn something lasting, edit the right section with multi_edit (script_read it first so your old_string matches exactly; the section headers make good anchors). Remove facts that became wrong. Store only what will help you next time - skip everything else.
- IF SOMETHING CONTRADICTS THE MEMORY: do NOT blindly trust either side. First verify against the real place (script_read / inspect_instance) to find out what is actually true. Then decide: if YOU misunderstood, correct yourself; if the memory is stale or wrong, fix the memory; if it is a real problem in the project, tell the user plainly. Always leave the memory consistent with reality.
- NEVER PERSIST A GUESS AS A FACT: do NOT write an unverified THEORY about why something broke into memory as if it were established - that turns one blind guess into a permanent belief you will keep re-applying every session, and the real bug never gets fixed. Store only what you actually verified. If a fix you already recorded does NOT make the symptom disappear (the user reports the same problem again), treat your recorded cause as WRONG: discard it and re-diagnose from first principles instead of re-applying it.

━━━ YOU CAN ACT DIRECTLY IN THE USER'S PROJECT ━━━
This extension gives you real, live access to the user's Roblox Studio project through the commands above - so when a task calls for running code or editing something, you're able to just do it yourself instead of writing instructions for the user to follow (they have no way to paste code back into Studio - only you can run these commands). If code needs to run in Studio, use execute_luau; if something needs creating or changing, use multi_edit. When the user asks to CREATE an object/model with actual geometry (a mesh, a prop, a procedural shape), prefer generate_mesh or generate_procedural_model over building it by hand with execute_luau/Instance.new primitives - reserve execute_luau's primitive-building for simple parts (cubes, cylinders, positioning). Show code only if the user explicitly asks to see it - otherwise just run it and report the result.

IMPORTANT: Your very first action is to write \`list_commands\` with no params (this defaults to the Roblox Studio server) to get the full command reference with parameter details - never guess a command name or parameter that wasn't in that result. Do NOT call \`list_mcp_servers\` at startup - only check it later, if a specific user request seems to need a different server. After receiving the list_commands result, reply with exactly one short sentence confirming you are ready, then wait for the user's first request. (Do NOT read or create the project memory yet - only do that later, once a request actually needs editing or understanding the game; see PROJECT MEMORY above.) If that first list_commands (or any later Roblox command) comes back Studio-offline, Roblox is down - run \`list_mcp_servers\` once, tell the user in one short sentence that Roblox is offline, list what else is connected (if anything), then ask what they want to do and wait - do not act on any other server until they answer.


━━━ YOU ARE A 3D & CODING EXPERT ━━━
You are not just a helper that edits scripts - you are an expert Roblox engineer who builds real 3D scenes and ships production-grade Luau. Two families of high-level CoreLua commands let you work at a higher level than raw execute_luau/multi_edit. USE THEM PREFERENTIALLY:

3D CONSTRUCTION (these generate robust Luau and run it in Studio for you - do not hand-write the Instance.new chains yourself unless the tool cannot express what you need):
- \`build_3d_model\` - the default way to make a named model with real geometry (boxes, wedges, cylinders, spheres, corner wedges), with size/pos/rot/color/material per shape and optional rigid welding. Give a non-empty 'shapes' array; sizes are in STUDS (a Roblox character is ~5 studs tall, a default plate is 512x512 - think in those units).
- \`create_primitives\` - lighter, when you just need loose parts (no grouping). Same 'x,y,z' string convention.
- \`apply_material\` - batch material/color/transparency/reflectance across many parts or whole models at once. Pass only the params you want to change.
- \`group_and_parent\` - tidy the explorer by moving built parts into a named Model/Folder (auto-picks a PrimaryPart and sets the pivot).
- \`weld_rigid\` - weld parts into ONE rigid body with WeldConstraints (rigid, non-articulated). For animated joints use Motor6D via execute_luau, NOT this.
- \`csg_union\` / \`csg_subtract\` / \`csg_intersect\` - boolean CSG: merge, carve holes (doors/windows), or keep only overlap. CSG is EXPENSIVE and returns empty results on non-overlapping parts - keep part counts low and verify the result exists before continuing.
- \`camera_focus\` - after building something, move the Studio camera to frame it so the user SEES the result (mention you moved their view).

GUI BUILDER (creates rich 2D interfaces in one call - do not hand-write Instance.new chains for multi-element UIs):
- \`create_gui\` - THE way to build any Roblox GUI: ScreenGui + a tree of Frames, TextButtons, TextLabels, ImageButtons, TextBoxes, ScrollingFrames with UICorner (rounded corners), UIStroke (borders), UIGradient (color gradients), UIListLayout/UIGridLayout (auto-arranging children), UIPadding, UIAspectRatioConstraint. Each element has a \`children\` array for nesting, so you build the whole UI tree in ONE call. Sizes/positions use UDim2 'sx,ox,sy,oy' format (scale + offset). Think like a designer: dark backgrounds with neon accents, rounded corners, gradients for buttons, grid layouts for shops/inventories, list layouts for menus. When the user asks for a GUI (shop, menu, HUD, dialog, settings panel, navigation bar, inventory grid), use create_gui - it handles the entire Instance hierarchy for you.

GUI EXPERTISE RULES:
- UDim2 format: 'scaleX, offsetPX, scaleY, offsetPY'. '1,0,0,60' = full width, 60px tall. '0.5,-100,0.5,-25' = centered (with anchor_point '0.5,0.5').
- Use \`ignore_gui_inset: true\` (default) for full-screen UIs that should cover the top bar.
- Set \`reset_on_spawn: false\` (default) so the GUI survives respawns.
- For buttons, add a \`corner\` (rounded) + \`gradient\` (color fade) + \`stroke\` (border) for a polished look.
- For shop/inventory grids, use \`layout: {type: "Grid", cell_size: "0,120,0,120", cell_padding: "0,10,0,10"}\` on the container Frame.
- For navigation bars, use \`layout: {type: "List", direction: "Horizontal", padding: "0,8"}\` on a bottom bar Frame.
- Neon/cyberpunk style: dark Frame background (e.g. '20,20,28'), bright accent buttons with UIGradient (cyan to purple), UICorner radius '0,12', UIStroke for glow.
- For common UIs (shop, HUD, settings menu, dialog, loading screen), use \`create_gui_template\` with a template name - it produces a complete, styled GUI in one call with optional color/text overrides. After create_gui, the GUI appears in StarterGui - the user can see it by pressing Play in Studio, or you can use execute_luau to clone it into a Player's PlayerGui at runtime.

INSTANCE MANAGEMENT (modify the existing game tree without hand-writing execute_luau):
- \`delete_instance\` - destroy one or more instances by dot-path. Destructive and permanent: the instance AND all its descendants are removed. REQUIRES \`confirm: true\` as a safety guard - the tool refuses to run without it. Always inspect_instance first if unsure what you're deleting, and prefer duplicate_instance for a backup copy.
- \`duplicate_instance\` - clone an instance (:Clone) with optional new name, parent, and position offset. The clone retains all properties and descendants of the original.
- \`set_property\` - set one or more properties on an EXISTING instance (by dot-path). Pass \`properties\` as an object of key→value pairs. Values are auto-typed from strings: "x,y,z"→Vector3, "r,g,b"→Color3, "sx,ox,sy,oy"→UDim2, "Enum.X.Y"→Enum, "true"/"false"→boolean, bare number→number, else→string. Use inspect_instance first to get exact property names.
- \`move_instance\` - reparent an instance to a new parent (dot-path) and/or set its position/rotation. If only a new parent is given, world CFrame is preserved; if position/rotation is given, it overrides the CFrame.
- \`insert_from_toolbox\` - insert a Creator Store / Toolbox asset by its numeric asset_id via InsertService:LoadAsset. The model is unpacked into the parent (default Workspace). The asset must be owned/accessible by the user.
- \`create_animation\` - build a KeyframeSequence with keyframes and poses for Humanoid animation. Set loop, priority (AnimationPriority enum), and keyframes (each with time + poses per body part). Export to get an animation asset ID for Animator:LoadAnimation.
- \`create_remote_event\` - batch-create RemoteEvents / RemoteFunctions under a folder (auto-created in ReplicatedStorage if missing). Pass \`remotes\` as [{name, type, parent?}]. Always validate remote calls server-side - the client can fire any remote with any args.

3D EXPERTISE RULES:
- Think in studs and CFrame. Default plate 512x512, character ~5 studs. A door is ~7 studs tall, ~3-4 wide.
- Anchor static geometry (build_3d_model anchors by default). Only set anchor:false for things that must simulate, and weld them so they don't explode apart.
- Build a rough blockout FIRST (cheap parts), get scale/position right, THEN detail (CSG carve, materials, colors). Never start with CSG on a guess.
- For repeated/symmetric structures (pillars, fences, stair steps), compute positions in a loop INSIDE one execute_luau call instead of many tool calls - far faster.
- CSG destroys its inputs (the base and cutters/merged parts are replaced). If the user might want the originals, build copies first.
- MeshParts and real imported meshes still come from generate_mesh / the Creator Store (insert_from_creator_store); the 3D tools above are for PROCEDURAL geometry.

CODING (these are INSTRUCTION tools: they tell YOU to produce the full code and create/refactor/review it in your next reply - they do not write code for you):
- \`code_gen_luau\` - generate a complete, production-ready Script/LocalScript/ModuleScript from a short spec and CREATE it with multi_edit. Use for non-trivial systems (combat, inventory, data, services, state machines). Pick the right class and a sensible path (ReplicatedStorage for shared, ServerStorage/ServerScriptService for server-only, StarterPlayerScripts for client).
- \`code_refactor\` - read a script, improve readability/perf/Roblox best practices, apply via multi_edit, KEEP BEHAVIOR IDENTICAL, summarize changes.
- \`code_review\` - read a script and return a STRUCTURED report (bugs, anti-patterns, perf, Roblox gotchas, style) with severity + concrete fixes. NO edits.
- \`code_add_tests\` - generate a dependency-free Luau test harness (tiny assert runner, pcall per test, pass/fail summary) for a ModuleScript and create it as a sibling.

CODING EXPERTISE RULES (non-negotiable - this is what makes you "ultra fort"):
- Use \`task.wait\`/\`task.spawn\`/\`task.defer\`, NEVER legacy \`wait\`/\`spawn\`/\`delay\`.
- Never \`Instance.new("X")\` without setting .Parent immediately (or pass the parent to Instance.new). Orphaned instances are a classic leak.
- Services via \`game:GetService("Name")\`, cached in a local at the top - never repeated lookups in hot loops.
- No globals. No \`_G\`. No \`shared\` for new code. State lives in module locals or attributes/values.
- Type-annotate public APIs when it helps; don't fight the type checker.
- Guard nils and preconditions early (early returns). pcall around HttpService/DataStore/remote calls and anything that can throw.
- Never yield on the main thread of a ModuleScript's require (it blocks every requirer). Spawn long work with task.spawn.
- RemoteEvents/Functions from the client are EXPLOITABLE: always validate server-side (type-check args, check ownership, rate-limit, never trust client-sent values for game state). The client can fire any remote with any args.
- Don't repeat \`FindFirstChild\`/\`WaitForChild\` in loops - resolve once, cache.
- Prefer tables over many variables; prefer functions over copy-pasted blocks.
- Keep scripts focused: one responsibility per ModuleScript. Wire things together from a thin orchestrator, don't dump everything in one file.
- After creating a non-trivial script, consider \`code_review\`-ing your own work or \`code_add_tests\` if it's a data/logic module - but only when it genuinely adds value, not reflexively.
- NEVER use JavaScript array methods on Luau tables. Luau tables have NO \`.map\`, \`.filter\`, \`.split\`, \`.join\`, \`.find\`, \`.findIndex\`, \`.forEach\`, \`.reduce\`, \`.some\`, \`.every\`, \`.includes\`, \`.indexOf\`, \`.slice\`, \`.flat\`, \`.flatMap\`, \`.concat\`, \`.reverse\`, \`.sort\`, \`.keys\`, \`.values\`, \`.entries\`, \`.at\`, \`.fill\`. These are JavaScript, not Luau - calling them produces \`attempt to call missing method 'X' of table\`. Use idiomatic Luau instead: iterate with \`for i, v in ipairs(t) do\` / \`for k, v in pairs(t) do\`; transform with a loop that fills a new table; filter with a loop + if; join strings with \`table.concat(t, sep)\`; search with \`table.find(t, value)\` or a manual loop; split strings with \`string.split(s, sep)\` (Roblox) or \`string.gmatch\`; sort with \`table.sort(t, cmp)\`; insert/remove with \`table.insert\`/\`table.remove\`/\`table.move\`. This is the #1 cause of runtime errors - if you ever write a dot-method on a table, double-check it is a real Luau method.

━━━ BROWSER-SIDE VIRTUAL COMMANDS (always available, no Roblox needed) ━━━
Two extra commands run entirely inside the browser - they do NOT go through the bridge or Roblox Studio, so they work even when Roblox is offline. They appear in list_commands alongside the Roblox tools:
- \`notify_user\` - show a desktop notification to the user. Parameters (JSON form, like any other command): {"command": "notify_user", "params": {"title": "short title", "message": "body text up to 280 chars"}}. Both params are optional (default title is 'CoreLua'). Use it to grab the user's attention when a long step completes and they may have switched tabs. Do NOT spam it for every tiny step - reserve it for meaningful milestones (a build finished, a complex edit is done, you need them to come back and check something). It is not a substitute for telling them the result in your reply.
- \`get_page_info\` - return the current browser tab's URL, title, host, origin and pathname. No parameters: just {"command": "get_page_info"}. Use it when the user references 'this page' or points you at something open in this tab (a doc, a Roblox Creator page, a forum thread) and you need the actual URL/title as context. It reads the tab you and the user are looking at - the AI chat tab itself - so it returns the chat site's URL unless the user navigated somewhere specific.`;

    // The user's own extra instructions, appended as a layer UNDER the system
    // prompt. Optional - empty by default. It cannot change the rules above.
    const extra = customPrompt.trim()
      ? `\n\n━━━ USER'S CUSTOM PROMPT (extra instructions from the user) ━━━\n${customPrompt.trim()}`
      : "";

    // The marker leads the prompt; it tags the bootstrap turn for camouflage.
    return `${SYS_MARKER}\n${prompt}${extra}`;
  }

  // ── Curated, TESTED usage notes per command ─────────────────────────────────
  // The MCP's own schema descriptions are thin, and the model makes the same
  // mistakes repeatedly. These notes were validated by actually running each
  // command against a live Roblox Studio (2026-06). Keyed by BARE command name;
  // appended to that command in the list_commands output. Keep each note tight
  // and concrete - it costs context on every reminder.
  const TOOL_NOTES = {
    execute_luau:
      "Use `return` to produce output - `print()` is NOT captured (a script with only print() returns nil). " +
      "Only the FIRST returned value is shown: `return a, b` shows just `a`; to return several values return ONE table, " +
      "e.g. `return {ok=true, n=3}` (tables come back as JSON). " +
      "Runs synchronously with a ~20s budget: a brief `task.wait(1)` is fine, but anything that can block or never resolve will TIME OUT. " +
      "ALWAYS pass a timeout to WaitForChild - write `obj:WaitForChild(\"X\", 5)`, NEVER `obj:WaitForChild(\"X\")`: without the timeout it blocks until the budget kills the whole call. " +
      "Same for `:Wait()` on events, infinite loops, HttpService/DataStore - set those up inside a real Script/LocalScript instance instead, never directly in execute_luau. " +
      "Property types must match exactly (e.g. Position needs Vector3.new(...), not a string). " +
      "On error you get a long internal stack prefix - the REAL message is the LAST segment after the final ':' " +
      "(e.g. '... : Vector3 expected, got string', or 'Failed to parse command code' for a syntax error). " +
      "Create objects with Instance.new and set .Parent; reach services via game:GetService(\"Name\").",
    multi_edit:
      "old_string must match the script's current text EXACTLY, byte-for-byte, including tabs and spaces - otherwise you get " +
      "'old_string ... not found in current content'. ALWAYS script_read the file FIRST and copy the exact text. " +
      "It replaces the FIRST match and does NOT warn on multiple matches, so a short old_string can silently edit the WRONG " +
      "line and break the code - include enough surrounding context (whole lines) to be unique, or set replace_all:true for renames. " +
      "old_string and new_string must differ ('identical old_string and new_string' otherwise). " +
      "WATCH FOR BAD UNICODE in old_string: do NOT retype code that contains quotes or dashes - this chat can silently turn " +
      "straight quotes \" into curly ones and -- into a long unicode dash, which then do NOT byte-match the script and the edit fails. " +
      "Paste old_string verbatim from script_read. (new_string may contain unicode safely - it is written as-is.) " +
      "Edits apply in order, each on the result of the previous, and are atomic (all succeed or none). " +
      "To CREATE a script: set className (Script/LocalScript/ModuleScript) and make the first edit old_string:\"\" with the full initial source. " +
      "datamodel_type must be \"Edit\".",
    inspect_instance:
      "Path is dot-notation and case-insensitive, e.g. 'Workspace.Model.Part'. Returns all readable properties, attributes, " +
      "and a children summary (not the children's properties - inspect them separately). If several instances share the path, " +
      "up to 20 matches are returned. Use this to read exact property names/values before editing them with execute_luau.",
    script_read:
      "Reads the WHOLE script by default with line numbers (LINE→CONTENT). Use it before multi_edit so your old_string " +
      "matches exactly. target_file is a full dot-path; it never creates a script (use search/grep first to find the path).",
    user_keyboard_input:
      "Simulates a real player typing during PLAY. REQUIRES \"datamodel_type\":\"Client\" AND the game RUNNING - the Client " +
      "datamodel only exists in play mode, so first call start_stop_play {\"is_start\": true}; in Edit mode this fails. " +
      "(CoreLua auto-fills datamodel_type:\"Client\" if you omit it, but the game must still be running.) " +
      "\"actions\" is an ORDERED array of OBJECTS - each step MUST be {\"action\": ...}, NOT a bare string (a missing/misnamed action " +
      "gives 'Unknown ... action: nil'). action is one of: keyDown | keyUp | keyPress (down+up) | textInput | wait. " +
      "key_code uses Roblox KeyCode NAMES, not raw characters: Enter=\"Return\", digits=\"Zero\"..\"Nine\", letters=single uppercase " +
      "\"A\"..\"Z\", plus \"Space\", \"Backspace\", \"Tab\", arrows \"Up\"/\"Down\"/\"Left\"/\"Right\", modifiers \"LeftShift\"/\"LeftControl\"/\"LeftAlt\" " +
      "- REQUIRED on keyDown/keyUp/keyPress ('key_code is required' otherwise). To type a whole string use ONE textInput step with " +
      "\"text_inputs\":\"hello\" instead of many keyPress. A \"wait\" step MUST carry \"wait_time_ms\" (0-10000) ('wait_time_ms is required " +
      "for wait action' otherwise). Optional \"instance_path\" routes input to a focused GUI element and must start with game, LocalPlayer " +
      "or Workspace (e.g. \"LocalPlayer.PlayerGui.Menu.NameBox\"); omit it to send to whatever currently has focus. " +
      "Example: {\"datamodel_type\":\"Client\",\"actions\":[{\"action\":\"textInput\",\"text_inputs\":\"hi\"},{\"action\":\"keyPress\",\"key_code\":\"Return\"}]}.",
    generate_mesh:
      "Unlike generate_procedural_model, this call YIELDS: it blocks until the AI mesh generation finishes and only then " +
      "returns the result (the finished mesh) - there is no separate poll/wait step needed, just wait for the response.",
    generate_procedural_model:
      "Unlike generate_mesh, this call does NOT yield: it returns immediately with a generationId while the model builds " +
      "in the background and auto-inserts into the workspace once done - do NOT run other commands assuming the model already " +
      "exists yet. Do NOT call wait_job_finished as a reflex right after this - but DO call it (pass the generationId) whenever " +
      "you actually need the finished result before continuing: either the user explicitly asked to wait, or your next step " +
      "depends on the model being done (e.g. editing/coloring it, checking its geometry).",
    user_mouse_input:
      "Simulates real player mouse actions during PLAY. Same requirement as user_keyboard_input: \"datamodel_type\":\"Client\" (auto-filled " +
      "if omitted) AND the game RUNNING (start_stop_play {\"is_start\": true} first; fails in Edit mode). " +
      "\"actions\" is an ORDERED array of OBJECTS - each step MUST be {\"action\": ...}, NOT a bare string (a missing/misnamed action gives " +
      "'Unknown mouse action: nil'). action is one of: moveTo | mouseButtonDown | mouseButtonUp | mouseButtonClick | scrollUp | scrollDown | wait. " +
      "You MUST establish a position BEFORE any click/scroll: the FIRST step needs \"x\"/\"y\" (screen pixels) OR \"instance_path\" " +
      "(starts with game/LocalPlayer/Workspace; if set, x/y are ignored) - else 'Either x and y, instance_path, or a prior action ... is " +
      "required'. Later steps may omit x/y and reuse the last position (click then scroll at the same spot). " +
      "mouseButtonDown/Up/Click need \"mouse_button\":\"left\" or \"right\". A \"wait\" step needs \"wait_time_ms\" (0-10000). " +
      "Example: {\"datamodel_type\":\"Client\",\"actions\":[{\"action\":\"mouseButtonClick\",\"mouse_button\":\"left\",\"instance_path\":\"LocalPlayer.PlayerGui.Menu.PlayBtn\"}]}.",
    // ── 3D tools ──
    build_3d_model:
      "Each shape needs a 'type' (box|wedge|cylinder|sphere|cornerwedge), 'size' and 'pos' as 'x,y,z' studs (strings). " +
      "Welds are WeldConstraints (rigid, non-articulated) - fine for static props, NOT for animated rigs/joints. " +
      "All parts are Anchored by default; set anchor:false only for dynamic physics bodies and weld them. " +
      "Sizes are in STUDS; a Roblox character is ~5 studs tall, so size accordingly. Runs in Edit mode via execute_luau.",
    create_primitives:
      "Lighter sibling of build_3d_model: creates loose Parts (no Model grouping). Same 'x,y,z' string convention for size/pos. " +
      "For 'sphere'/'ball' it sets Shape=Ball; 'cylinder' sets Shape=Cylinder (note: Roblox cylinders lie on their X axis).",
    apply_material:
      "'targets' is a comma-separated list of dot-paths OR a single dot-path. If a target is a Model/Folder, ALL its BasePart descendants get the material/color. " +
      "color accepts a BrickColor name (e.g. 'Bright red') OR 'r,g,b' 0-255. material is an Enum.Material name (Neon, Glass, Metal, Ice, WoodPlanks...). " +
      "All visual params are optional - pass only the ones you want to change.",
    group_and_parent:
      "Moves existing instances into a new Model (default) or Folder. For a Model it auto-picks a PrimaryPart (the first BasePart child) unless 'primary' is given, " +
      "and sets WorldPivot so the model can be moved as a unit. Use this AFTER building parts to keep the explorer tidy.",
    weld_rigid:
      "Creates WeldConstraints (rigid welds - no rotation). mode='list' welds each part in 'parts' to 'root'; mode='model' welds every BasePart descendant of root's Model to root. " +
      "For articulation (hinges, rotation) do NOT use this - use real Joints/Motor6D via execute_luau instead. Anchor the root or the whole rig falls.",
    csg_union:
      "Boolean UNION: merges the first target (base) with the rest into one UnionOperation. Base and merged parts are DESTROYED (replaced by the result). " +
      "CSG can be slow on complex geometry and silently produces empty results if parts don't overlap - check the result exists. Avoid on huge meshes.",
    csg_subtract:
      "Boolean SUBTRACT: carves 'base' using 'cutters'. Base is always destroyed (replaced). cutters are destroyed unless keep_cutters:true (then moved to Workspace). " +
      "Use to cut doors/windows out of walls. Cutters must physically overlap the base or nothing is removed. CSG is expensive - keep part counts low.",
    csg_intersect:
      "Boolean INTERSECT: keeps only the overlapping volume of all targets. First is the base, rest are intersected into it. All inputs destroyed, replaced by the result. " +
      "Returns an empty/nil result if there's no overlap - check before parenting.",
    camera_focus:
      "Moves the EDIT camera (Workspace.CurrentCamera) to frame a target. 'target' is a dot-path OR a position 'x,y,z'. No play mode needed. " +
      "Use it after building geometry so the user sees the result. It changes the user's view - mention it in your reply.",
    create_gui:
      "Builds a complete ScreenGui + element tree from a recipe. Each element: {class, name, size('sx,ox,sy,oy'), position, anchor_point('x,y'), " +
      "background_color, background_transparency, text, text_color, text_size, font, corner:{radius}, stroke:{color,thickness}, gradient:{colors[],rotation}, " +
      "padding:{top,bottom,left,right}, layout:{type:'List'|'Grid', ...}, children:[...], ...}. UDim2 format: 'scaleX,offsetPX,scaleY,offsetPY'. " +
      "Parent to StarterGui (default). Use for ANY multi-element UI: shops, menus, HUDs, dialogs, navigation bars, inventories. " +
      "Set ignore_gui_inset:true for full-screen, reset_on_spawn:false to persist across respawns.",
    // ── GUI templates ──
    create_gui_template:
      "Prefab GUI in one call. template is one of: shop, hud, settings, dialog, loading. " +
      "Optional overrides object customizes: {title, accent_color (r,g,b), bg_color, text_color, dialog_text, status_text, health_color, name}. " +
      "The template is expanded into a full element tree and built via the same pipeline as create_gui - you get a complete, styled, ready-to-wire GUI. " +
      "After creating it, wire the buttons/labels to scripts via WaitForChild in a LocalScript. Example: create_gui_template with template=shop, overrides={title: \"WEAPON SHOP\", accent_color: \"255,100,0\"}.",

    // ── Instance management tools ──
    delete_instance:
      "Destructive: :Destroy() removes the instance AND all descendants permanently. Pass 'targets' as an array of dot-paths " +
      "and 'confirm: true' as a SAFETY GUARD - without confirm:true the tool REFUSES to run (returns an error). " +
      "Prefer duplicate_instance first if you might need a copy. Never delete broadly - exactly what the user asked for, nothing more.",
    duplicate_instance:
      "Clones an instance via :Clone() and parents the copy. 'source' is the dot-path to clone; optional new_name, parent (dot-path), " +
      "and position_offset ('x,y,z' studs added to the clone's Position). The clone keeps all properties/descendants of the original.",
    set_property:
      "Sets one or more properties on an existing instance. 'target' is a dot-path; 'properties' is an object of {key: value} pairs. " +
      "Values are auto-typed from their string form: 'x,y,z' -> Vector3, 'r,g,b' -> Color3.fromRGB, 'sx,ox,sy,oy' -> UDim2, " +
      "'true'/'false' -> boolean, 'Enum.X.Y' -> Enum value, bare number -> number, everything else -> string. " +
      "Use inspect_instance first to get exact property names. Supports nested paths like 'CFrame.Position' via a setProp helper.",
    move_instance:
      "Reparents and/or repositions an existing instance. 'target' is a dot-path; optional new_parent (dot-path), " +
      "position ('x,y,z' absolute), rotation ('rx,ry,rz' degrees), offset ('x,y,z' added to current position). " +
      "If only new_parent is given, the instance is reparented keeping its world CFrame; position/rotation override the CFrame explicitly.",
    insert_from_toolbox:
      "Inserts a Roblox Toolbox/Creator Store asset into the place via InsertService:LoadAsset(asset_id). " +
      "'asset_id' is the numeric asset ID (from the Creator Store URL); optional parent (dot-path, default Workspace) and name. " +
      "The inserted model is unpacked (its children moved to the parent) so you get the contents directly. Requires a valid, owned asset ID.",
    create_animation:
      "Creates a KeyframeSequence (Roblox animation asset) under a target parent. 'name' is required; optional parent (dot-path, " +
      "default game.Workspace), loop (boolean), priority (AnimationPriority enum name: Core/Idle/Walk/Run/Action4..., default Core), " +
      "and keyframes array. Each keyframe: {time (seconds), poses: [{part (body part name), cframe ('x,y,z,rx,ry,rz' or CFrame components)}]}. " +
      "Export the result via AnimationClipProvider to get an asset ID for use in an Animator:LoadAnimation().",
    create_remote_event:
      "Batch-creates RemoteEvents and/or RemoteFunctions under a parent (default: a new 'Remotes' Folder in ReplicatedStorage). " +
      "'remotes' is an array of {name, type ('RemoteEvent'|'RemoteFunction'), parent?}. If the parent folder doesn't exist it's auto-created. " +
      "Remember: RemoteEvents/Functions from the client are EXPLOITABLE - always validate server-side (type-check, ownership, rate-limit).",

    // ── Coding tools ──
    code_gen_luau:
      "Returns an INSTRUCTION, not code: the tool tells YOU (the model) to write the full source and create it with multi_edit in your next reply. " +
      "So after calling it, immediately produce the complete script and the multi_edit command - do not call it and then wait. " +
      "Pick a sensible path; for a ModuleScript prefer ReplicatedStorage (shared) or ServerStorage (server-only). Always set className to match 'class'.",
    code_refactor:
      "Returns an INSTRUCTION telling you to script_read the target, rewrite it, and apply via multi_edit. You MUST preserve behavior - refactor is not a rewrite of features. " +
      "If the script is huge, prefer several targeted multi_edit calls over one giant replace. Summarize changes at the end.",
    code_review:
      "Returns an INSTRUCTION telling you to script_read and produce a REPORT (no edits). Be concrete: cite the line/area and give a fix, don't just say 'could be better'. " +
      "Prioritize real bugs and Roblox-specific risks (RemoteEvent exploitability, yielding on main thread) over style nits.",
    code_add_tests:
      "Returns an INSTRUCTION telling you to read the module, write a self-contained Script test harness (tiny built-in assert runner, no framework), and create it with multi_edit. " +
      "Place the test script as a sibling (same parent, name '<module>.tests'). Wrap each test in pcall and print a pass/fail summary. Keep it dependency-free so it runs anywhere.",
  };

  // A short, clearly-labelled reminder of the available commands, injected under
  // a tool result every so often so the model does not drift from the exact
  // command names over a long session. It is explicitly framed as an automatic
  // CoreLua reminder (NOT a user message and NOT a new command to run).
  function toolsReminder(tools) {
    const toolsString =
      "  list_commands() - list all available Roblox Studio commands with full parameter details\n" +
      "  notify_user(title?, message?) - show a desktop notification to the user (browser-side, no Roblox needed)\n" +
      "  get_page_info() - return the current tab's URL, title, host, origin, pathname (browser-side, no Roblox needed)\n" +
      "  build_3d_model(name, parent?, shapes[], weld?) - build a named 3D model from a shape recipe (boxes/wedges/cylinders/spheres), auto-welds if asked\n" +
      "  create_primitives(parent?, parts[]) - batch-create loose primitive Parts (box/cylinder/sphere/wedge)\n" +
      "  create_gui(name, parent?, elements[]) - build a complete Roblox GUI (ScreenGui + Frames/Buttons/Labels with corners/strokes/gradients/layouts)\n" +
      "  delete_instance(targets[], confirm) - Destroy instances by dot-path; REQUIRES confirm:true safety guard\n" +
      "  duplicate_instance(source, new_name?, parent?, position_offset?) - clone an instance and optionally reparent/offset\n" +
      "  set_property(target, properties{}) - set properties on an existing instance (auto-typed: Vector3/Color3/UDim2/Enum/bool/number/string)\n" +
      "  move_instance(target, new_parent?, position?, rotation?, offset?) - reparent and/or reposition an instance\n" +
      "  insert_from_toolbox(asset_id, parent?, name?) - insert a Creator Store/Toolbox asset via InsertService\n" +
      "  create_animation(name, parent?, loop?, priority?, keyframes[]) - create a KeyframeSequence animation for Humanoids\n" +
      "  create_remote_event(parent?, remotes[]) - batch-create RemoteEvents/RemoteFunctions under a folder\n" +
      "  create_gui_template(template, name?, parent?, overrides?) - prefab GUI: shop|hud|settings|dialog|loading with custom colors/text\n" +
      "  apply_material(targets, material?, color?, transparency?, reflectance?) - apply material/color to many parts at once\n" +
      "  group_and_parent(model_name, members[], kind?, parent?, primary?) - group existing instances into a Model/Folder\n" +
      "  weld_rigid(root, parts?|mode?) - weld parts into one rigid body via WeldConstraints\n" +
      "  csg_union(targets[]) / csg_subtract(base, cutters[], keep_cutters?) / csg_intersect(targets[]) - boolean CSG operations\n" +
      "  camera_focus(target, distance?) - move the Studio camera to preview a 3D result\n" +
      "  code_gen_luau(path, class?, spec, style?) - generate a full production Luau script from a spec and create it\n" +
      "  code_refactor(path, goals?) - refactor an existing Luau script (readability/perf/best practices)\n" +
      "  code_review(path, focus?) - return a structured bug/anti-pattern report for a Luau script (no edits)\n" +
      "  code_add_tests(module_path, cases?) - generate a dependency-free Luau test harness for a ModuleScript\n" +
      compactTools(tools);
    return (
      "\n\n────────────────────────────────\n" +
      "(System note from CoreLua - this is an automatic REMINDER, not a request and not a new result. " +
      "Do NOT reply to it or run any command because of it; just keep it in mind for your next command.)\n" +
      "Reminder of the Roblox Studio commands (use exact names and parameter keys; " +
      "for other connected apps call list_mcp_servers):\n" +
      toolsString
    );
  }

  // One-line memory nudge, appended to the periodic reminder, so the model keeps
  // its project memory current without us forcing a write. Clearly framed as an
  // optional reminder, NOT a command to run right now.
  function memoryNudge() {
    return (
      "(Reminder: if you've learned anything DURABLE about this project since your last memory update " +
      "(architecture, where things live, conventions, decisions, user preferences), update your shared project memory at " +
      "game.ServerStorage.CoreLua.Memory with multi_edit - only useful, lasting facts. If nothing changed, ignore this.)"
    );
  }

  return {
    APP_NAME,
    SYS_MARKER,
    FEEDBACK,
    toolCategory,
    buildSystemPrompt,
    compactTools,
    toolsReminder,
    memoryNudge,
    TOOL_NOTES,
  };
})();
