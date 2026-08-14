# 🛡️ Security Policy

## 📋 Overview

Corelua is an open-source AI-powered bridge designed to connect AI websites such as **DeepSeek** and **Google Gemini** with **Roblox Studio**.

Corelua does **not** require or use official DeepSeek or Gemini API keys. The system works through the supported AI websites and a local bridge.

The bridge is designed specifically for Roblox-related tools and workflows. 🎮

## 🔗 Supported Architecture

The general workflow is:

```text
🤖 DeepSeek / Gemini
        ↓
🌐 AI Website
        ↓
🌉 Corelua Bridge
        ↓
🧰 Roblox Tools
        ↓
🎮 Roblox Studio
```

Corelua may also create a `Corelua` folder containing ModuleScripts inside Roblox Studio's `ServerStorage` to organize or store generated requests and related project data.

## 🔐 Security Scope

The bridge is intended to operate with tools related to Roblox Studio.

It is **not intended to provide unrestricted access to the user's computer**. 💻

Any tool capable of interacting with files or Roblox Studio should be treated as potentially security-sensitive and should only perform actions required for its intended functionality.

## 📁 Local Files

Corelua may interact with files related to Roblox Studio workflows.

Users should only run Corelua from a trusted copy of the official repository.

⚠️ Do not replace project files with files obtained from untrusted sources.

## 🎮 Roblox Studio

Because Corelua can interact with Roblox Studio and create project content, users should review generated or modified content before publishing or distributing a Roblox experience.

Users should be especially careful with:

* 📜 Generated scripts
* 📦 ModuleScripts
* 🔌 Plugins
* 🧩 Other executable Roblox content

AI-generated code should always be reviewed before being trusted in a production project.

## 🤖 AI-Generated Content

Corelua may receive instructions and generate content through supported AI websites.

AI-generated output should be considered **untrusted input**.

Users should review generated code before executing, publishing, or distributing it.

🚫 Never provide AI services with sensitive information such as:

* 🔑 Passwords
* 🎟️ Authentication tokens
* 🔐 Private keys
* 👤 Personal credentials
* 📂 Confidential project information

## ▶️ `start.bat`

Corelua is started using the project's `start.bat` launcher.

⚠️ Windows batch files can execute commands on the local machine.

Users should therefore verify that `start.bat` comes from the official Corelua repository before executing it.

🚫 Never run a modified or unknown copy of `start.bat` from an untrusted source.

## 🔑 API Keys

Corelua does **not** require DeepSeek or Gemini API keys.

Users should never be asked to provide their DeepSeek or Gemini API keys to Corelua.

🚨 If an unofficial version of Corelua requests API keys, passwords, browser credentials, or authentication tokens, users should treat it as potentially malicious and report it.

## 🌐 Browser & Account Security

Corelua interacts with DeepSeek and Gemini through their websites.

Users are responsible for securing their own browser profiles and accounts. 🔒

Corelua should not intentionally collect or expose:

* 🔑 Browser passwords
* 🍪 Authentication cookies
* 🎟️ Session tokens
* 👤 Account credentials
* 🔐 Private browser data

Users should avoid running untrusted versions of the bridge while logged into sensitive accounts.

## 🚨 Reporting a Vulnerability

If you discover a security vulnerability in Corelua, please report it **privately** instead of publicly disclosing the vulnerability.

### 📧 Security Contact

**Email:** [nexiratstudiocontact@gmail.com](mailto:nexiratstudiocontact@gmail.com)

Please include as much of the following information as possible:

* 📝 A clear description of the vulnerability
* 🏷️ The affected Corelua version
* 🔄 Steps to reproduce the issue
* 💥 The potential security impact
* 🧪 A proof of concept, if available
* 📸 Relevant logs or screenshots

⚠️ Please remove passwords, authentication tokens, private files, and other sensitive information before sending a report.

## 🤝 Responsible Disclosure

We ask security researchers and users to allow reasonable time for a vulnerability to be investigated and fixed before publicly disclosing technical details.

Security reports will be reviewed and addressed according to their severity and impact. 🛠️

## 🌍 Third-Party Services

Corelua interacts with third-party AI websites, including **DeepSeek** and **Google Gemini**.

These services are independently operated and may have their own security policies, terms of service, and privacy practices.

Users are responsible for complying with the applicable terms and policies of the services they use. 📜

## 🧑‍💻 Open Source

Corelua is an open-source project.

Users should obtain the bridge and related files from the official project repository whenever possible. 📦

Before running scripts such as `start.bat`, users are encouraged to inspect the source code and verify that the files have not been modified by an untrusted third party.

## ✅ Security Best Practices

For the safest experience:

1. 📥 Download Corelua only from the official repository.
2. 🔍 Review changes before running `start.bat`.
3. 🔄 Keep Roblox Studio and Corelua up to date.
4. 👀 Review AI-generated Roblox code before using it.
5. 🚫 Never share passwords, tokens, or private credentials with Corelua.
6. ⚠️ Do not run modified copies of the bridge from untrusted sources.
7. 🚨 Report suspicious behavior privately to the security contact.

## ⚠️ Disclaimer

Corelua is provided on an **"as is"** basis.

No software can guarantee complete security. Users should review AI-generated code and generated Roblox content before using it in a live or production environment.

---

🛡️ **Security contact:** [nexiratstudiocontact@gmail.com](mailto:nexiratstudiocontact@gmail.com)

🤖 **Project:** Corelua

📅 **Last updated:** August 14, 2026
