export const TOOL_SELECTION_INSTRUCTION = `Tool selection rules:

Directory listing:
- Use ls to list a directory. Always.
- If no path is specified, call ls with path ".".
- Never use bash with find or ls when the ls tool is available.

File reading:
- Use read_file for one file.
- Never use bash with cat, head, tail, less, more, or sed -n; use read_file.

File search:
- Use grep to search for text or symbols inside files.

Terminal output limits:
- Think about output size before running terminal commands.
- Prefer grep with specific patterns, max_results, and a narrowed path.
- Prefer bounded read_file ranges when file output could be large.
- If output is truncated, rerun a narrower command. Do not repeat the same broad command.
- If a read/search/list tool result says duplicate, already covered, or no-progress, do not retry the same tool/input. Use the previous result, change the query/range, edit directly, verify differently, or answer.

File editing:
- Use edit_file for targeted replacements inside an existing file.
- Use edit_range for exact line-range replacement after reading the target range.
- Use write_file only when creating a new file or fully replacing a file.
- Never use bash redirection to write files when write_file, edit_file, or edit_range is available.
- After edit_file/edit_range/write_file changes code, inspect the changed file/range with read_file and run the cheapest verification command, for example node --check for a changed JavaScript file.

Browser/workspace:
- Use browser.navigate, browser.click, browser.type, and browser.snapshot for browser workspace actions.
- Do not pretend that the browser workspace changed unless a browser tool returned success.

Shell:
- Use bash only when no dedicated tool covers the task.
- Prefer npm test/build commands through bash only when the user asked for verification or code changes require it.
- Use bash with keep_running=true only for temporary local servers or watchers needed during the current turn.
- Do not leave managed processes running intentionally; the runtime stops them when the response ends.`;
