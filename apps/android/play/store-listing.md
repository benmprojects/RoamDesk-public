# Google Play store listing — DRAFT

Items in [square brackets] must be supplied. Character limits are Google Play's.

## App name (30 characters max)

**Read this first.** "Claude" is Anthropic's trademark. Google Play can refuse or remove apps whose names suggest they come from another company, so check with Anthropic before using it, or pick a name of your own. Options:

- Roam Desk *(as now; needs Anthropic's OK for a public listing)*
- Drive Desk — voice for your PC
- PC Pilot Voice
- [your choice]

For **internal testing only**, the listing isn't public, so the name matters less. It still needs fixing before any wider release.

## Short description (80 characters max)

> Talk to your PC hands-free from the car. Your own AI assistant, on your own PC.

(79 characters)

## Full description (4,000 characters max)

> Get things done on your Windows PC by voice, wherever you are, including while you drive.
>
> Roam Desk connects your phone to a helper app on your own PC. Press Talk, on screen, on your steering wheel or in Android Auto, and say what you need. Claude carries it out on your PC and reads back the answer.
>
> WHAT YOU CAN DO
> • Ask about files, folders and your PC: "How much space is left?", "Find last week's quote."
> • Run tasks: organise files, check on a long job, lock your PC.
> • Use your connected services, such as email, calendar and Teams, through your own Claude account.
> • Have files sent to your phone to open, share or save.
> • Pick up a conversation you started on your PC, and hand it back when you're at your desk.
>
> BUILT FOR THE CAR
> • Hands-free: push-to-talk from your steering wheel, headset or Android Auto.
> • Short spoken answers, read aloud.
> • Risky actions wait for you to say "confirm" first, and "stop everything" cancels all work instantly.
>
> PRIVATE BY DESIGN
> • Your phone talks only to your own PC, over your private network.
> • No ads, no analytics, no tracking. The developer receives none of your data.
> • Every action is recorded in a log on your PC that you control.
>
> WHAT YOU NEED
> • A Windows PC running the free Roam Desk helper.
> • A Claude subscription, used through Claude Code on your PC.
> • Tailscale on both your phone and your PC.
>
> Always follow road rules and drive safely. Only use voice features when it is safe to do so.

## Category and details

| Field | Value |
|---|---|
| App category | Productivity |
| Tags | Productivity, Tools |
| Price | Free |
| Contains ads | No |
| Email (required) | Enter in Play Console only (not stored in this repository) |
| Website (optional) | [website] |
| Privacy policy URL (required) | https://benmprojects.github.io/RoamDesk-public/privacy |

## Graphics Play asks for

| Asset | Size | Status |
|---|---|---|
| App icon | 512 × 512 PNG | I can export it from the app's existing icon |
| Feature graphic | 1024 × 500 | To make |
| Phone screenshots | 2 to 8 | Take from the phone (Drive, Conversation, Sessions, Settings) |
| Android Auto screenshots | Optional | I can capture these from Google's car emulator on your PC |

## Content rating questionnaire (suggested answers)

No violence, sexual content, profanity, drugs, gambling or user-generated content shared with others. The app can open web pages and files on the user's own PC. Expected rating: Everyone, or the lowest available.

## Data safety form (suggested answers, check before submitting)

- **Data collected by the developer:** none. The app sends what you say only to your own PC; nothing goes to the developer.
- **Data shared with third parties:** none by the app. Speech recognition is done by the phone's speech service.
- **Encrypted in transit:** yes (Tailscale).
- **Users can request deletion:** yes. Everything is on the phone and removed by unpairing or uninstalling.

Google's definition of "collected" covers data sent off the device. Because requests leave the phone to reach your own PC, read Google's guidance on user-controlled destinations before choosing "no data collected".

## App access (for Google's reviewers)

The app needs a paired Windows PC, so reviewers can't use it without one. For internal testing this isn't checked. For a public release you'd need to describe this in **App access**, and may need to provide a demo setup.
