const fs = require("fs");
const CLParse = new Function(fs.readFileSync(__dirname + "/core/parser.js", "utf8") + "; return CLParse;")();
let fail = 0;
const ok = (name, cond) => { if (!cond) { fail++; console.log("FAIL  " + name); } };
const show = (name, v) => console.log("INFO  " + name + ": " + JSON.stringify(v));

// 1. Two JSON commands -> parseToolCalls should find both (multiTool path)
const two = CLParse.parseToolCalls('{"command": "list_commands"} then {"command": "get_studio_state"}');
show("two json commands", two && two.map((c) => c.tool));
ok("two json commands found", two && two.length === 2);

// 2. Command inside prose with narration
const prose = 'Let me check the studio first. {"command": "get_studio_state"} I will report back.';
show("prose-wrapped", CLParse.parseToolCalls(prose) && CLParse.parseToolCalls(prose).map((c) => c.tool));
ok("prose-wrapped found", CLParse.parseToolCalls(prose) && CLParse.parseToolCalls(prose).length === 1);

// 3. ###LUA### inside MCP wrapper
const wrapped = '###MCP_TOOL###\n###LUA###\nreturn 42\n###END_LUA###\n###END_MCP_TOOL###';
show("lua in mcp wrapper", CLParse.parseToolCalls(wrapped) && CLParse.parseToolCalls(wrapped).map((c) => c.tool));
ok("lua in mcp wrapper", CLParse.parseToolCalls(wrapped) && CLParse.parseToolCalls(wrapped)[0] && CLParse.parseToolCalls(wrapped)[0].tool === "execute_luau");

// 4. JSON with escaped quotes and nested braces in params
const nested = '{"command": "multi_edit", "params": {"edits": [{"old_string": "if x then { return } end", "new_string": "y"}]}}';
show("nested braces", CLParse.parseToolCalls(nested) && CLParse.parseToolCalls(nested)[0] && CLParse.parseToolCalls(nested)[0].tool);
ok("nested braces parsed", CLParse.parseToolCalls(nested) && CLParse.parseToolCalls(nested).length === 1);

// 5. Markdown fence around the JSON
const fenced = '```json\n{"command": "list_commands"}\n```';
show("fenced json", CLParse.parseToolCalls(fenced) && CLParse.parseToolCalls(fenced).map((c) => c.tool));
ok("fenced json found", CLParse.parseToolCalls(fenced) && CLParse.parseToolCalls(fenced).length === 1);

// 6. Dash end marker
const dash = '###LUA###\nreturn 1\n###END-LUA###';
show("dash end marker", CLParse.parseToolCalls(dash) && CLParse.parseToolCalls(dash).map((c) => c.tool));
ok("dash end marker", CLParse.parseToolCalls(dash) && CLParse.parseToolCalls(dash).length === 1);

// 7. Injected feedback must NOT be detected as a command
const fb = "Output of 'execute_luau':\n2";
ok("feedback not a command", CLParse.hasCommandShape(fb) === false);

// 8. ERROR feedback quoting a command example must not be detected
const errFb = 'ERROR: write {"command": "name"} exactly.';
ok("error quoting command not detected", CLParse.hasCommandShape(errFb) === false || CLParse.isInjectedFeedback(errFb) === true);

// 9. Open block mid-stream
ok("open lua detected", CLParse.hasOpenToolBlock("###LUA###\nlocal x = 1") === true);
ok("open json detected", CLParse.hasOpenToolBlock('{"command": "multi_edit", "params": {"a"') === true);
// closed json NOT open
ok("closed json not open", CLParse.hasOpenToolBlock('{"command": "list_commands"}') === false);

// 10. LUA with :Server suffix mid-stream
ok("server suffix parsed", (() => { const c = CLParse.parseToolCalls("###LUA:Server###\nreturn workspace.Name\n###END_LUA###"); return c[0].arguments.datamodel_type === "Server"; })());

// 11. markdown-mangled "### LUA : client ###"
ok("spaced client dm", (() => { const c = CLParse.parseToolCalls("### LUA : client ###\nreturn 1\n###END_LUA###"); return c[0].arguments.datamodel_type === "Client"; })());

// 12. toolNameFromText mid-stream
ok("tool name mid-stream", CLParse.toolNameFromText('{"command":"multi_ed') === "multi_ed");

console.log(fail ? `\n${fail} FAILURES` : "\nALL ADVERSARIAL TESTS PASSED");
process.exit(fail ? 1 : 0);
