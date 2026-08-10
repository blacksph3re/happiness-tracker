# Happiness tracker

Track your satisfaction with work/life/whatever in regular questionaries, then get automated statistics.

## Installation

To install everything, just build the Dockerfile and run through docker. You may want to set some environment variables:

- `PORT` - the port exposed, by default 8000
- `DB_STORAGE` - Where the sqlite .db file is stored, by default database.db
- `ADMIN_USER` - The username of the initial admin acccount
- `ADMIN_PASSWORD` - The password of the initial admin account
- `BOOTSTRAP_QUESTION_CATALOGUE` - If you want to bootstrap an initial catalogue of questions as a default (0/1)
- `JWT_SECRET` - The key used to sign session tokens. If unset, a random one is generated at startup, which logs every user out on every restart - set it for any real deployment.
- `ACCESS_TOKEN_TTL` - How long a session token stays valid before it has to be refreshed, by default 1h
- `REFRESH_TOKEN_TTL` - How long a user stays logged in without re-entering their password, by default 30d
- `PASSWORD_MIN_LENGTH` - Minimum length of a user password, by default 8

After installation, you want to define the questions that will be answering regularly. Questions are grouped in catalogues and every user has a default catalogue that will be automatically opened when he/she logs in.

## Catalogue

There are three types of questions
- Enum: A set of values that have no numeric correlation (Male/Female, Yes/No, Apples/Pears/Bananas, ...)
- Discrete: Discrete values that have a scale, an order is assumed (1/2/3/4/5). They have a lower and upper bound with a description (low/high), increment is always 1.
- Continuous: Continuous values that have a scale. They have a lower and upper bound with a description but no increments.

Furthermore, there are some answers that are always tracked automatically per day, if the user answered any questions:
- Weekday
- Day of the year
- Month
- Year
- Hour of the day when the first question was answered

The default catalogue is the [WHO-5 Well-Being Index](https://www.corc.uk.net/outcome-measures-guidance/directory-of-outcome-measures/the-world-health-organisation-five-well-being-index-who-5/), reproduced verbatim so answers stay comparable with the published instrument. All five are discrete questions on the WHO-5's own six-point scale, from 0 "At no time" to 5 "All of the time":

- I have felt cheerful and in good spirits
- I have felt calm and relaxed
- I have felt active and vigorous
- I woke up feeling fresh and rested
- My daily life has been filled with things that interest me

Note that the WHO-5 is validated over a two-week recall window. Answering it daily is an adaptation: your own trend over time is meaningful, but the published clinical cut-offs do not apply to a single day's score.

Questions are edited in the question catalogue edit page. This supports some fundamental options
- Add new question
- Add an enum option
- Change bounds/descriptions for a discrete/continuous action.
- Deactivate a question - it will no longer be displayed in the questionnaire.

In general, all changes to the question catalogue will never modify previous answers.

## User management

The admin user is the only user in the system that can create or delete users. Every user has a username + password and a default catalogue.

The landing page for every user, given it is still logged in, is directly the first question for the day. The user can start answering right away. There is also an option to get to the menu (top right stacked bar button) where the user can select its default catalogue, see stats or change the password. When all questions of the day are answered, it is automatically forwarded to the stats page.

## Question answering

Question answering is as seemless as possible. On tall screens, questions are arranged vertically, on wide screens horizontally. It requires exacly one interaction to answer one question (e.g. drag the continuous slider, click a discrete/enum value) to answer a question, after which the next one is opened after a short flip-page animation. With a back/forth button, questions can be skipped or answers corrected. By default, the questions for the current day are answered. Through the answer table, a past or future day can also be selected and questions can be answered or updated for other days

## Answer table

This is just a tabular display of the answers. The user can see each exact answer it gave. The table scrolls along the x axis for days.

Furthermore, a .xlsx download is available.

## Stats page

The main point of the app is to track mental KPIs over time. The job of the stats page is to display these stats. There are multiple views
- Simple line plots over time for each discrete/continuous variable
- Radar charts for every discrete/continuous variable
- Scatter plots that show correlation between any two variables
- Boxplots that show distribution of variables across timespans (weeks, months, ...)

Every plot that does not have a time axis allows to be smoothely animated across time through a time slider at the top of the corresponding stats page.

## Non-functional requirements

- The app is fully responsive
- No server call is required between questions, only at initial page load the whole catalogue is loaded into the frontend. 
- Answers are directly submitted through PUT at click but the server confirmation is not awaited before continuing user interaction
- Failed backend requests are displayed to the user with a toast.
- The backend stores passwords securely, they are never logged
- Every endpoint except for /version and /login require a valid JWT. This is asserted with a test for every endpoint that passes correct inputs but an invalid JWT.
- The system is performant enough to render question tracking over multiple years
- We expect a relatively low number of questions per catalogue (ca 10), design the UI for this amount.

