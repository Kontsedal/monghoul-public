# Security

## Reporting a vulnerability

Email **contact@monghoul.com** with `security` in the subject. Please do not open a public issue
for a vulnerability, and please give us a chance to ship a fix before describing it publicly.

Useful things to include, as far as you have them:

- What an attacker can do, and what they need in order to do it
- The Monghoul version and your operating system
- Steps that reproduce it, or a proof of concept
- Anything you already know about a fix

You will get a reply. Monghoul is a small project and there is no bounty programme, so what we can
offer is an answer, a fix, and credit in the release notes if you would like it.

## What is in scope

The desktop application and the licence server behind it:

- The application itself, including the query sandbox and the driver layer under it
- Write protection, and any way to get a destructive operation past it
- The MCP server: its loopback binding, its token, the access scope, and the approval queue
- Licence activation and device binding
- `monghoul.com` and the download it serves

## What is not

- A finding that needs an attacker to already control the machine Monghoul runs on. Monghoul is a
  desktop application and it trusts the user it runs as.
- Write protection treated as a permission system. It is not one, and the documentation says so:
  it protects you from your own mistakes inside the app, and the credentials you connected with can
  still do whatever MongoDB allows them to do from `mongosh`. Use a MongoDB user with the roles you
  actually want. See [Write protection](https://monghoul.com/docs/concepts/write-protection/).
- Anything in a dependency that Monghoul does not reach. Say how it is reached and it is in scope.
- Missing hardening with no exploit behind it.

## What Monghoul sends

Queries, documents and connection strings are never sent anywhere. Connection profiles, tabs,
query history and themes are held in a local SQLite database on your own machine.

What does leave the machine is listed on
[Updates, privacy and support](https://monghoul.com/docs/reference/updates-and-privacy/), and a
failed licence check never removes access you already have, so an offline machine keeps working.
