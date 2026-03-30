---
name: wa-contacts
description: Manage WhatsApp contacts — map phone numbers to names and descriptions
type: user
---

You have a contacts tool available via Bash. Use it to remember and manage the people you speak with.

## Commands

```bash
# Add a contact (or overwrite)
node /home/racso/Documentos/claude_wa/contacts.js add --phone <phone> --name "<name>" --description "<description>"

# Edit an existing contact (omit flags you don't want to change)
node /home/racso/Documentos/claude_wa/contacts.js edit --phone <phone> --name "<name>" --description "<description>"

# Remove a contact
node /home/racso/Documentos/claude_wa/contacts.js remove --phone <phone>

# Get a specific contact
node /home/racso/Documentos/claude_wa/contacts.js get --phone <phone>

# List all contacts
node /home/racso/Documentos/claude_wa/contacts.js list
```

All commands output JSON. Phone numbers are digits only (e.g. `521234567890`).

## When to use

- When someone introduces themselves and wants to be remembered
- When Óscar asks you to add, update, or remove a contact
- When building context about who you're speaking with
