# SmartDesk AI scenario test report

**Run date:** October 11, 2026  
**Result:** 24 tests passed, 0 failed  
**Runtime:** Node.js v24.19.0 on Windows; Node's built-in test runner  
**Live Agents API:** Not run because `OPENAI_API_KEY` was not set in the build environment.

## Test counts

| Area | Tests | Passed | Failed |
| --- | ---: | ---: | ---: |
| Knowledge base and retrieval | 5 | 5 | 0 |
| Ticket workflow, validation, and confirmation | 11 | 11 | 0 |
| Jira adapter and service errors | 4 | 4 | 0 |
| Agent definition and credential handling | 2 | 2 | 0 |
| Configuration and portability | 2 | 2 | 0 |
| **Total automated tests** | **24** | **24** | **0** |

An additional knowledge-base smoke check passed: it loaded 49 entries and ranked the password-reset entry first for a password-reset query. This smoke check is reported separately and is not included in the 24 automated tests.

## Scenarios covered

1. Knowledge base minimum size and IT, HR, payroll, and onboarding category coverage.
2. Password-reset retrieval ranking and expense-reimbursement retrieval ranking.
3. Unknown-topic retrieval fallback and empty/stopword-only queries.
4. Local ticket creation, generated tracking ID, initial status, and email-scoped lookup.
5. Invalid email handling, multiple-ticket listing, exact ticket selection, and no matching tickets.
6. Required summary and description validation and unknown function-call handling.
7. Ticket proposal staging without writes, explicit confirmation, changed proposal rejection, and malformed email rejection.
8. Jira issue creation payload, employee attribution, labels/project fields, and returned ticket link.
9. Jira status lookup email matching, false-positive filtering, no matches, and HTTP 403 degradation.
10. Agent name/model/reasoning/multi-agent configuration and web/function tool registration.
11. Missing OpenAI credentials produce a clear error without making a request.
12. Ticket provider selection with complete Jira settings versus demo mode.
13. Valid portable KB JSON with no machine-specific absolute paths.

## Verification boundary

Jira REST calls were exercised with mocked HTTP responses, including success, empty results, false-positive filtering, and an authorization failure. The local ticket store and confirmation checks ran against the actual application code. No live OpenAI session, live Jira project, or cross-machine deployment was exercised. Those require credentials and a configured destination environment.

## Re-run

Run `npm test` from the project folder. Run `npm run kb:check` for the separate retrieval smoke check. Configure `OPENAI_API_KEY` before running `npm start` to create/use the reusable agent and open a live streamed session.
