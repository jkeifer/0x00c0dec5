#!/usr/bin/env node

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Get git commit hash
let commitHash = 'unknown';
try {
    commitHash = execSync('git describe --match=NeVeRmAtCh --always --abbrev=8 --dirty', {
        encoding: 'utf8',
    }).trim();
} catch (error) {
    console.warn('Warning: Could not get git commit hash:', error.message);
}

// Create build info for injection
const buildInfo = {
    commit: commitHash,
    buildTime: new Date().toISOString(),
};

// Write to a file that can be imported by the application
const buildInfoPath = path.join(process.cwd(), 'src', 'build-info.js');
const buildInfoContent = `// Auto-generated build information
export const BUILD_INFO = ${JSON.stringify(buildInfo, null, 2)};
`;

fs.writeFileSync(buildInfoPath, buildInfoContent);
console.log(`Build info written to ${buildInfoPath}`);
console.log(`Commit: ${commitHash}`);
