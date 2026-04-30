# Security Policy

## Reporting a vulnerability

If you discover a security issue in the Epplaa platform, please
report it privately so we can remediate it before public disclosure.

- Email: **security@epplaa.com**
- Encrypted communication: PGP key fingerprint published at
  `https://epplaa.com/.well-known/security.txt` once available.

Please include:

- A description of the issue and its potential impact.
- Steps to reproduce, or a proof of concept.
- Any relevant log excerpts, screenshots, or HTTP captures.

We acknowledge receipt within **2 business days**, share an initial
triage within **5 business days**, and aim to remediate critical and
high-severity issues within **30 days**.

## Coordinated disclosure

We follow a 90-day coordinated-disclosure window from confirmed
report to public advisory, extendable by mutual agreement when a fix
requires deeper structural change.

## Scope

In scope:

- Production hosts under `*.epplaa.com`.
- The mobile applications published to the App Store and Play Store
  under the Epplaa publisher account.
- The source code in this repository.

Out of scope:

- Social-engineering attacks on Epplaa staff or third parties.
- Denial-of-service attacks.
- Findings only reproducible against deprecated browsers
  (anything older than the latest two stable versions of Chrome,
  Safari, Firefox, and Edge).

## Safe harbour

We will not pursue legal action against researchers who:

1. Make a good-faith effort to avoid privacy violations, data
   destruction, or service disruption.
2. Do not exploit findings beyond what is necessary to demonstrate
   the vulnerability.
3. Report findings privately and give us reasonable time to fix.
