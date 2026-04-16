import { PlaywrightCrawler, Configuration, Sitemap } from 'crawlee';
import fs from 'fs';
import { URL } from 'url';

// Parse command line arguments
const arg = process.argv[2];
if (!arg) {
    console.error('❌ Please provide a URL to crawl.');
    console.error('Usage: node NewFormSniffer.js <https://example.com>');
    process.exit(1);
}

// Normalize the URL
let startUrl = arg;
if (!startUrl.startsWith('http://') && !startUrl.startsWith('https://')) {
    startUrl = 'https://' + startUrl;
}

const parsedUrl = new URL(startUrl);
const hostname = parsedUrl.hostname;
const urlsFile = `urls_${hostname.replace(/[^a-zA-Z0-9]/g, '_')}.txt`;

console.log(`🚀 Starting Super Robust Form Sniffer for: ${startUrl}`);
console.log(`⏳ Output will be saved to: ${urlsFile}\n`);

// Data structures
const discoveredUrls = new Set();
const formsFound = new Map();
const sampledFolders = new Set();

// 

const config = new Configuration({
    headless: true,
});

// Create the crawler
const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: 100,
    
    browserPoolOptions: {
        useFingerprints: false, // Disabling due to Node v25 zip-reader bug
    },

    // We increase timeout slightly for rigorous network waiting
    requestHandlerTimeoutSecs: 30,

    async requestHandler({ page, request, enqueueLinks }) {
        console.log(`[CRAWLING] ${request.loadedUrl}`);
        discoveredUrls.add(request.loadedUrl);

        const currentHostname = new URL(request.loadedUrl).hostname.replace(/^www\./, '');

        await enqueueLinks({
            transformRequestFunction: (requestOptions) => {
                try {
                    const urlObj = new URL(requestOptions.url);
                    const targetHost = urlObj.hostname.replace(/^www\./, '');

                    // STRICT HOST BOUNDARY ENFORCER
                    if (!targetHost.includes(currentHostname) && !currentHostname.includes(targetHost)) {
                        return false; 
                    }

                    const segments = urlObj.pathname.split('/').filter(Boolean); 
                    
                    if (segments.length === 0 || segments.length === 1) {
                        return requestOptions; 
                    }

                    if (segments.length > 1) {
                        const baseFolder = segments[0].toLowerCase(); 
                        if (sampledFolders.has(baseFolder)) {
                            return false; 
                        } else {
                            sampledFolders.add(baseFolder);
                            return requestOptions;
                        }
                    }
                } catch (e) {
                    return false; 
                }
                return requestOptions;
            },
        });

        // STABILIZE NETWORK + LAZY LOADING: 
        // Force scroll to the bottom of the page to trigger "below the fold" lazy-loaded HubSpot iframes!
        try {
            await page.waitForLoadState('networkidle', { timeout: 3000 });
            await page.evaluate(async () => {
                await new Promise((resolve) => {
                    let totalHeight = 0;
                    const distance = 300;
                    const timer = setInterval(() => {
                        window.scrollBy(0, distance);
                        totalHeight += distance;
                        if (totalHeight >= document.body.scrollHeight || totalHeight > 5000) {
                            clearInterval(timer);
                            resolve();
                        }
                    }, 100);
                });
            });
            await page.waitForTimeout(3000); // Wait 3 seconds AFTER scrolling for the iframes to finish popping in
        } catch (e) {
            // Timeout gracefully, page might have polling pixels, proceed anyway
        }

        const allExtractedForms = [];

        // IFRAME ITERATION: Scan main page AND all embedded iframes
        for (const frame of page.frames()) {
            try {
                const frameUrl = frame.url();
                const frameForms = await frame.evaluate(() => {
                    const extracted = [];
                    
                    // 0. GLOBAL PAGE CAPTCHA CHECK (Defeats Wix/Enterprise detached iframes)
                    let globalCaptcha = 'None';
                    if (document.querySelector('.g-recaptcha, [name="g-recaptcha-response"], script[src*="recaptcha"], iframe[src*="recaptcha/enterprise"]')) {
                        globalCaptcha = 'Google reCAPTCHA';
                    } else if (document.querySelector('.h-captcha, [name="h-captcha-response"], script[src*="hcaptcha"], iframe[src*="hcaptcha"]')) {
                        globalCaptcha = 'hCaptcha';
                    } else if (document.querySelector('.cf-turnstile, [name="cf-turnstile-response"], script[src*="turnstile"], iframe[src*="challenges.cloudflare.com"]')) {
                        globalCaptcha = 'Cloudflare Turnstile';
                    }
                    
                    // 1. STANDARD + IFRAME FORMS
                    const formElements = Array.from(document.querySelectorAll('form'));
                    for (let i = 0; i < formElements.length; i++) {
                        const form = formElements[i];
                        
                        const action = (form.action || '').toLowerCase();
                        const id = (form.id || '').toLowerCase();
                        const className = (form.className || typeof form.className === 'string' ? form.className : '').toLowerCase();
                        
                        let isSearchForm = action.includes('search') || id.includes('search') || className.includes('search');
                        
                        const inputs = Array.from(form.querySelectorAll('input, textarea, select'));
                        const fields = [];
                        let hasEmail = false;

                        for (let input of inputs) {
                            const type = (input.type || input.tagName).toLowerCase();
                            const name = (input.name || '').toLowerCase();
                            const placeholder = (input.placeholder || '').toLowerCase();

                            if (type === 'search' || name === 'q' || name.includes('search') || placeholder.includes('search')) {
                                isSearchForm = true;
                            }
                            if (['hidden', 'submit', 'button', 'image'].includes(type)) continue; 

                            let labelText = '';
                            if (input.id) {
                                const label = document.querySelector(`label[for="${input.id}"]`);
                                if (label) labelText = label.innerText.trim();
                            }
                            if (!labelText && input.closest('label')) {
                                labelText = input.closest('label').innerText.replace(input.value || input.placeholder || '', '').trim();
                            }
                            if (!labelText && input.parentElement && input.parentElement.tagName !== 'FORM') {
                                // Fallback for Wix/Squarespace random div wrappers
                                labelText = input.parentElement.innerText.replace(input.value || input.placeholder || '', '').trim();
                            }

                            const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();

                            if (type === 'email' || name.includes('email') || placeholder.includes('email') || labelText.toLowerCase().includes('email') || ariaLabel.includes('email')) {
                                hasEmail = true;
                            }

                            fields.push({
                                name: input.name || 'unnamed-field',
                                type: type,
                                placeholder: input.placeholder || 'No placeholder',
                                label: labelText || ariaLabel || 'No label'
                            });
                        }

                        if (isSearchForm || fields.length === 0 || !hasEmail) continue; 

                        extracted.push({
                            id: form.id || `form-${i}`,
                            action: form.action || 'No Action',
                            method: form.method || 'GET',
                            fields: fields,
                            captcha: globalCaptcha,
                            isIframe: false // determined outside
                        });
                    }

                    // 2. PHANTOM / UNWRAPPED FORMS (React/Vue floating inputs)
                    const floatingInputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]), textarea, select'))
                        .filter(input => !input.closest('form'));

                    const validFloating = [];
                    let hasSearchStr = false;
                    let hasEmail = false;

                    for (let input of floatingInputs) {
                        const type = (input.type || input.tagName).toLowerCase();
                        const name = (input.name || '').toLowerCase();
                        const placeholder = (input.placeholder || '').toLowerCase();
                        const id = (input.id || '').toLowerCase();
                        const className = (input.className || typeof input.className === 'string' ? input.className : '').toLowerCase();

                        // If this specific input is a search bar, just skip THIS input, but don't kill the whole phantom form array!
                        if (type === 'search' || name === 'q' || name.includes('search') || placeholder.includes('search') || id.includes('search') || className.includes('search')) {
                            continue; 
                        } 

                        let labelText = '';
                        if (input.id) {
                            const label = document.querySelector(`label[for="${input.id}"]`);
                            if (label) labelText = label.innerText.trim();
                        }
                        if (!labelText && input.closest('label')) {
                            labelText = input.closest('label').innerText.replace(input.value || input.placeholder || '', '').trim();
                        }
                        if (!labelText && input.parentElement && input.parentElement.tagName !== 'FORM') {
                            labelText = input.parentElement.innerText.replace(input.value || input.placeholder || '', '').trim();
                        }

                        const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();

                        if (type === 'email' || name.includes('email') || placeholder.includes('email') || id.includes('email') || className.includes('email') || labelText.toLowerCase().includes('email') || ariaLabel.includes('email')) {
                            hasEmail = true;
                        }

                        validFloating.push({
                            name: input.name || 'unnamed-floating-field',
                            type: type,
                            placeholder: input.placeholder || 'No placeholder',
                            label: labelText || ariaLabel || 'No label'
                        });
                    }

                    if (hasEmail && validFloating.length > 0) {
                        extracted.push({
                            id: 'Phantom/Unwrapped Form',
                            action: 'Javascript Handled',
                            method: 'Unknown',
                            fields: validFloating,
                            captcha: globalCaptcha,
                            isPhantom: true
                        });
                    }

                    return extracted;
                });
                
                // Annotate iframe context
                if (frameForms.length > 0) {
                    if (frame !== page.mainFrame()) {
                        frameForms.forEach(f => {
                            f.isIframe = true;
                            f.frameUrl = frameUrl;
                        });
                    }
                    allExtractedForms.push(...frameForms);
                }
            } catch (e) {
                // Ignore Cross-Origin security deaths for unreadable frames
            }
        }

        if (allExtractedForms.length > 0) {
            console.log(`   --> Found ${allExtractedForms.length} meaningful form(s) on ${request.loadedUrl}`);
            formsFound.set(request.loadedUrl, allExtractedForms);
        }
    },

    failedRequestHandler({ request }) {
        console.error(`[FAILED] Request to ${request.url} failed.`);
    },
}, config);

async function run() {
    let urlsToCrawl = [{ url: startUrl, uniqueKey: startUrl }];

    console.log(`[INFO] Operating in Pure Dynamic Mode. Commencing organic crawl from the homepage...`);

    await crawler.run(urlsToCrawl);

    // --- LAST DITCH SITEMAP FALLBACK ---
    if (discoveredUrls.size <= 1) {
        console.log(`\n[WARNING] Dynamic crawl only found ${discoveredUrls.size} URL(s) on the tree. The site might be a single-page app or lack navigation.`);
        console.log(`[INFO] Initiating LAST-DITCH FALLBACK: Attempting to pull and filter sitemap.xml...`);
        try {
            const sitemapUrl = `${parsedUrl.origin}/sitemap.xml`;
            const sitemapResult = await Sitemap.load(sitemapUrl);
            
            if (sitemapResult.urls && sitemapResult.urls.length > 0) {
                console.log(`[INFO] Fallback found ${sitemapResult.urls.length} URLs in sitemap.`);
                
                const fallbackFolders = new Set();
                const filteredSitemapUrls = sitemapResult.urls.filter(u => {
                    try {
                        const targetHost = new URL(u).hostname.replace(/^www\./, '');
                        const rootHost = hostname.replace(/^www\./, '');
                        // Strictly enforce host boundaries for the sitemap fallback too
                        if (!targetHost.includes(rootHost) && !rootHost.includes(targetHost)) return false;

                        const segments = new URL(u).pathname.split('/').filter(Boolean);
                        if (segments.length === 0 || segments.length === 1) return true;
                        
                        const baseFolder = segments[0].toLowerCase();
                        if (fallbackFolders.has(baseFolder)) return false;
                        
                        fallbackFolders.add(baseFolder);
                        return true;
                    } catch (e) { return false; }
                }).map(u => ({ url: u, uniqueKey: u }));
                
                if (filteredSitemapUrls.length > 0) {
                    console.log(`[SUCCESS] Filtered fallback sitemap down to ${filteredSitemapUrls.length} prioritized URLs! Commencing second pass...`);
                    await crawler.run(filteredSitemapUrls);
                } else {
                    console.log(`[INFO] Fallback sitemap did not contain any valid URLs inside the domain boundaries.`);
                }
            } else {
                console.log(`[INFO] Fallback sitemap was completely empty.`);
            }
        } catch (e) {
            console.log(`[INFO] Fallback failed: No readable sitemap.xml exists at the root domain.`);
        }
    }

    // Save outputs
    const finalList = Array.from(discoveredUrls).sort();
    let fileContent = `=================================\n`;
    fileContent += `  Sniffer Results for ${hostname}\n`;
    fileContent += `=================================\n\n`;
    
    fileContent += `Discovered ${finalList.length} Unique URLs:\n`;
    fileContent += `----------------------------------\n`;
    fileContent += finalList.join('\n');
    
    if (formsFound.size > 0) {
        fileContent += `\n\n\nPages Containing Target Forms (${formsFound.size}):\n`;
        fileContent += `----------------------------------\n`;
        
        for (const [url, forms] of formsFound.entries()) {
            fileContent += `\n🔗 ${url}\n`;
            forms.forEach((form, idx) => {
                let badge = '';
                if (form.isIframe) badge += ` [EMBEDDED IFRAME: ${form.frameUrl}]`;
                if (form.isPhantom) badge += ` [PHANTOM/UNWRAPPED JS FORM]`;
                if (form.captcha && form.captcha !== 'None') badge += ` [CAPTCHA: ${form.captcha}]`;
                
                fileContent += `   [Form ${idx + 1}] ID/Class: ${form.id} | Action: ${form.action}${badge}\n`;
                
                form.fields.forEach(field => {
                    fileContent += `       - Input Name: "${field.name}" (Type: ${field.type})\n`;
                    if (field.label !== 'No label') {
                        fileContent += `         Label: ${field.label}\n`;
                    }
                    if (field.placeholder !== 'No placeholder') {
                        fileContent += `         Placeholder: ${field.placeholder}\n`;
                    }
                });
            });
        }
    } else {
        fileContent += `\n\n\nNo non-search forms were detected on this site.\n`;
    }

    fs.writeFileSync(urlsFile, fileContent);
    console.log(`\n🎉 Web crawl completed successfully!`);
    console.log(`📄 Check your output at: ${urlsFile}`);
}

run().catch((e) => {
    console.error('Fatal Crawler Error:', e);
    process.exit(1);
});
