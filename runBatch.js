import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import readline from 'readline';
import { URL } from 'url';

// --- CONFIGURATION ---
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '10', 10);
const INPUT_FILE = 'urls.txt';
const PROGRESS_FILE = 'progress.log';
const MASTER_CSV = 'master_results.csv';
const REPORTS_DIR = 'completed_reports';
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per site

// Ensure directories exist
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR);

// State tracking
const activeWorkers = new Set();
const processedUrls = new Set();

// Load progress
if (fs.existsSync(PROGRESS_FILE)) {
    const lines = fs.readFileSync(PROGRESS_FILE, 'utf-8').split('\n');
    lines.forEach(line => {
        if (line.trim()) processedUrls.add(line.trim());
    });
}

// Initialize CSV Header if new
if (!fs.existsSync(MASTER_CSV)) {
    const header = 'Domain,Page URL,Form ID,Action,Field Name,Field Type,Label,Placeholder,Captcha,Badge\n';
    fs.writeFileSync(MASTER_CSV, header);
}

/**
 * Parses the generated .txt report and appends to CSV
 */
function aggregateResults(domain, filePath) {
    if (!fs.existsSync(filePath)) return;

    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        
        let currentPage = '';
        let currentForm = null;

        for (const line of lines) {
            // Match Page URL
            const pageMatch = line.match(/🔗 (.*)/);
            if (pageMatch) {
                currentPage = pageMatch[1].trim();
                continue;
            }

            // Match Form ID / Action / Badges
            const formMatch = line.match(/\[Form \d+\] ID\/Class: (.*?) \| Action: (.*?)(?: \[(.*)\])?$/);
            if (formMatch) {
                currentForm = {
                    id: formMatch[1].trim(),
                    action: formMatch[2].trim(),
                    badge: formMatch[3] ? formMatch[3].trim() : 'Standard'
                };
                continue;
            }

            // Match Fields
            const fieldMatch = line.match(/- Input Name: "(.*?)" \(Type: (.*?)\)/);
            if (fieldMatch && currentForm) {
                const fieldName = fieldMatch[1];
                const type = fieldMatch[2];
                
                // Peek ahead for label/placeholder
                let label = 'N/A';
                let placeholder = 'N/A';
                
                // Simple stateful lookahead isn't easy in this loop, 
                // but we know they follow the field line directly.
            }
        }
        
        // RE-PARSING with a more structured block approach for fields
        const sections = content.split('🔗').slice(1);
        for (const section of sections) {
            const pageLines = section.split('\n');
            const pageUrl = pageLines[0].trim();
            
            const formBlocks = section.split(/ {3}\[Form \d+\]/).slice(1);
            for (const block of formBlocks) {
                const blockLines = block.split('\n');
                const headerLine = blockLines[0];
                
                const idMatch = headerLine.match(/ID\/Class: (.*?) \| Action: (.*?)(?: \[(.*)\])?$/);
                const formId = idMatch ? idMatch[1].trim() : 'Unknown';
                const action = idMatch ? idMatch[2].trim() : 'Unknown';
                const badges = idMatch && idMatch[3] ? idMatch[3].trim() : 'Standard';

                // Look for fields in the block
                const fieldEntries = block.split(/ {7}- Input Name:/).slice(1);
                for (const fieldEntry of fieldEntries) {
                    const lines = fieldEntry.split('\n');
                    const nameTypeMatch = lines[0].match(/"(.*?)" \(Type: (.*?)\)/);
                    if (!nameTypeMatch) continue;

                    const name = nameTypeMatch[1];
                    const type = nameTypeMatch[2];
                    
                    let label = 'N/A';
                    let placeholder = 'N/A';
                    
                    lines.forEach(l => {
                        if (l.includes('Label:')) label = l.replace(/.*Label: /, '').trim();
                        if (l.includes('Placeholder:')) placeholder = l.replace(/.*Placeholder: /, '').trim();
                    });

                    // Prepare CSV Row
                    const row = [
                        domain,
                        `"${pageUrl}"`,
                        `"${formId}"`,
                        `"${action}"`,
                        `"${name}"`,
                        `"${type}"`,
                        `"${label.replace(/"/g, '""')}"`,
                        `"${placeholder.replace(/"/g, '""')}"`,
                        badges.includes('CAPTCHA:') ? badges.match(/CAPTCHA: (.*?)(?=\]|$)/)[1] : 'None',
                        `"${badges}"`
                    ].join(',');

                    fs.appendFileSync(MASTER_CSV, row + '\n');
                }
            }
        }

        // Move file to reports dir
        const fileName = path.basename(filePath);
        fs.renameSync(filePath, path.join(REPORTS_DIR, fileName));
        
    } catch (e) {
        console.error(`[ERROR] Failed to aggregate results for ${domain}:`, e.message);
    }
}

/**
 * Runs the sniffer for a single domain
 */
function runSniffer(url) {
    return new Promise((resolve) => {
        console.log(`[BATCH] Starting: ${url}`);
        
        const hostnameCandidate = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
        const tempStorageDir = path.join('storage', `worker_${hostnameCandidate.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}`);

        const child = spawn(process.execPath, ['NewFormSniffer.js', url], {
            stdio: 'pipe',
            env: { ...process.env, CRAWLEE_STORAGE_DIR: tempStorageDir }
        });

        const timeout = setTimeout(() => {
            console.error(`[TIMEOUT] Killing ${url} after ${TIMEOUT_MS / 1000}s`);
            child.kill();
        }, TIMEOUT_MS);

        child.on('exit', (code) => {
            clearTimeout(timeout);
            console.log(`[BATCH] Finished: ${url} (Code: ${code})`);
            
            // Expected filename based on NewFormSniffer.js logic
            try {
                const hostname = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
                const expectedFile = `urls_${hostname.replace(/[^a-zA-Z0-9]/g, '_')}.txt`;
                
                // Only aggregate if file exists
                aggregateResults(hostname, expectedFile);
                
                // Record progress only if it succeeded or gracefully handled an empty site
                if (code === 0) {
                    fs.appendFileSync(PROGRESS_FILE, url + '\n');
                    processedUrls.add(url);
                }
            } catch (e) {
                console.error(`[ERROR] Post-processing failed for ${url}:`, e.message);
            } finally {
                // Cleanup temp storage to prevent hard drive from filling up
                if (fs.existsSync(tempStorageDir)) {
                    fs.rmSync(tempStorageDir, { recursive: true, force: true });
                }
            }
            
            resolve();
        });

        // Optional: Pipe errors to a log
        child.stderr.on('data', (data) => {
            fs.appendFileSync('logs/errors.log', `[${url}] ${data}`);
        });
    });
}

/**
 * Main Orchestrator
 */
async function main() {
    const fileStream = fs.createReadStream(INPUT_FILE);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    const queue = [];
    for await (const line of rl) {
        const url = line.trim();
        if (!url || processedUrls.has(url)) continue;
        queue.push(url);
    }

    console.log(`[INFO] Found ${queue.length} new URLs to process.`);
    
    let index = 0;
    const workers = [];

    async function next() {
        if (index >= queue.length) return;
        
        const url = queue[index++];
        await runSniffer(url);
        await next();
    }

    // Start initial workers
    for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i++) {
        workers.push(next());
    }

    await Promise.all(workers);
    console.log('\n🎉 ALL BATCHES COMPLETED SUCCESSFULLY!');
}

main().catch(err => {
    console.error('Fatal Orchestrator Error:', err);
    process.exit(1);
});
