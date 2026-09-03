#!/usr/bin/env node

import { runCommandLineFromProcess } from "../cli/main.js";

process.exitCode = await runCommandLineFromProcess();
