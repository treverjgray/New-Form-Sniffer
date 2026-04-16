# Enterprise Form Sniffer

An advanced, high-performance form discovery and extraction tool designed to process millions of domains with precision and speed. Built on top of Playwright and Crawlee, this tool specializes in deep-discovery of contact forms, checkout flows, and "phantom" forms that are handled purely by Javascript.

## ✨ Key Features

- **🚀 Concurrent Batch Processing**: Orchestrator that manages dozens of worker processes simultaneously with safe storage sandboxing.
- **🛡️ Anti-Bot Evasion**: Intelligent request handling and browser pool management to bypass standard bot detection. (Note: Fingerprinting is currently toggled for Node v25 compatibility).
- **🕵️ Deep Discovery**: Scans beyond the homepage, following internal links to find buried contact and lead-gen forms.
- **👻 Phantom Form Detection**: Identifies fields handled by Javascript without traditional `<form>` tags.
- **📦 Intelligent Aggregration**: Automatically parses individual site reports into a single, master CSV for data analysis.
- **🔄 Resume-ability**: Integrated checkpoint system allows for pausing and resuming massive crawls without data loss.

## 🛠️ Technical Stack

- **Runtime**: Node.js (v22+ recommended)
- **Engine**: [Crawlee](https://crawlee.dev/) + [Playwright](https://playwright.dev/)
- **Storage**: File-based session management with automatic clean-up.

## 🚀 Getting Started

### Prerequisites
- Node.js installed on your system.
- Playwright browsers installed.

### Installation
```bash
npm install
npx playwright install
```

### Usage

**Single Site Sniff:**
```bash
node NewFormSniffer.js google.com
```

**Batch Processing:**
1. Populate `urls.txt` with your domain list (one per line).
2. Run the orchestrator:
```bash
node runBatch.js
```

## 📊 Output
Results are aggregated into `master_results.csv` with the following columns:
- Domain
- Page URL
- Form ID
- Action
- Field Name
- Field Type
- Label
- Placeholder
- Captcha Detected
- Badge/Type

## ⚖️ License
MIT
