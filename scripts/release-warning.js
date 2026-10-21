#!/usr/bin/env node
const red = "\x1b[31m";
const reset = "\x1b[0m";
const msg =
  "[!!WARNING!!] The release scripts are DESTRUCTIVE! Any local changes to this branch will be lost after the script is done.";
console.error(`\n${red}${msg}${reset}\n`);

const delay = process.stdout.isTTY ? 3000 : 0;
setTimeout(() => {
  process.exit(0);
}, delay);
