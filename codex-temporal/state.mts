import { threadState } from "./src/client.js";
console.log(JSON.stringify(await threadState(process.argv[2]), null, 2));
process.exit(0);
