# Security

Please report vulnerabilities privately through GitHub:
**Security tab → Report a vulnerability**. Don't open a public issue.

Known by design: the Gemini key is entered by each user and stored in
localStorage (web) or the Keychain (iOS). The client still sends that key to
Google. Don't put a shared production key in the app. See
[Good to know](README.md#good-to-know).
