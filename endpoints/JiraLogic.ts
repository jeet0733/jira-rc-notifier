// Pure business logic for JiraWebhookEndpoint
// Each function is exported for unit testing
import { IRead, IModify } from '@rocket.chat/apps-engine/definition/accessors';
import { RoomType } from '@rocket.chat/apps-engine/definition/rooms';
import { IMessageAttachment } from '@rocket.chat/apps-engine/definition/messages';
import { ILogger } from '@rocket.chat/apps-engine/definition/accessors';

/**
 * Parses the incoming Jira webhook payload.
 */
export function parsePayload(payload: any) {
    const issue = payload.issue || {};
    const fields = issue.fields || {};
    const issueKey = issue.key;
    const issueSummary = fields.summary;
    const eventType = payload.webhookEvent || payload.issue_event_type_name;
    return { issue, fields, issueKey, issueSummary, eventType };
}

/**
 * Extracts all relevant participants from Jira fields and payload.
 * Handles standard, custom, and dynamic fields.
 */
export function extractParticipants(fields: any, payload: any, customFieldsSetting?: string): any[] {
    let participants: any[] = [];
    if (fields.assignee) participants.push(fields.assignee);
    if (fields.reporter) participants.push(fields.reporter);
    if (fields.creator) participants.push(fields.creator);
    if (fields.watches && Array.isArray(fields.watches.watchers)) {
        participants = participants.concat(fields.watches.watchers as any[]);
    }
    // Native Jira approvers field (array of user objects)
    if (Array.isArray(fields.approvers)) {
        participants = participants.concat(fields.approvers);
    }
    // Payload user
    if (payload.user) participants.push(payload.user);
    
    // Dynamic custom user fields
    //    The admin can pass a comma‐separated list of field‐keys that might be:
    //      • plain user arrays/objects, e.g. [ {displayName, ...}, … ]
    //      • OR “approval” objects, which themselves contain an array of { approver: {…} }.
    //
    //    Example `customFieldsSetting`: 
    //      "customfield_10200,customfield_11902,approvers,customfield_12345"
    //
    if (customFieldsSetting && typeof customFieldsSetting === 'string') {
        const customFields = customFieldsSetting.split(',').map((f: string) => f.trim()).filter(Boolean);
        for (const fieldKey of customFields) {
            const value = fields[fieldKey];

            // If this field is an array:
            if (Array.isArray(value)) {
                // Check if each item looks like an “approval” object (has `.approvers` array)
                const firstItem = value[0];
                if (firstItem && Array.isArray((firstItem as any).approvers)) {
                    // e.g. value = [ { approvers: [ { approver: {...} }, … ] }, … ]
                    for (const approvalObj of value) {
                        if (approvalObj && Array.isArray((approvalObj as any).approvers)) {
                            for (const approverWrapper of (approvalObj as any).approvers) {
                                if (approverWrapper && (approverWrapper as any).approver) {
                                    participants.push((approverWrapper as any).approver);
                                }
                            }
                        }
                    }
                } else {
                    // Otherwise, assume it’s a plain array of user‐objects
                    participants = participants.concat(value as any[]);
                }
            }
            // If this field is a single object:
            else if (value && typeof value === 'object') {
                // Maybe it’s an “approval” object with array .approvers
                if (Array.isArray((value as any).approvers)) {
                    for (const approverWrapper of (value as any).approvers) {
                        if (approverWrapper && (approverWrapper as any).approver) {
                            participants.push((approverWrapper as any).approver);
                        }
                    }
                }
                // Otherwise assume it’s one user‐object
                else {
                    participants.push(value);
                }
            }
            // If value is undefined/null or a primitive, skip it
        }
    }
    const unique = new Map<string, any>();
    for (const p of participants) {
        // console.log('Participants....................', p.name);
        // Build a dedupe‐key; if accountId is missing we fall back to emailAddress or name.
        const key = p.accountId ?? p.emailAddress ?? p.name;
        if (key && !unique.has(key)) {
            unique.set(key, p);
        }
    }

    return Array.from(unique.values());
    
    // Remove duplicates by accountId/emailAddress/name
    // return Array.from(new Map(participants.map((p: any) => [p.accountId || p.emailAddress || p.name, p])).values());
}

/**
 * Maps Jira participants to Rocket.Chat users using mapping and field selection.
 * Returns an array of { username, rcUser, error } objects.
 */
export interface IMapResult {
    username?: string;
    rcUser?: any;
    error?: string;
    participant?: any;
}

export interface IMapOutput {
    results: IMapResult[];
    warnings: string[];
}

export async function mapToRCUsers(
    participants: any[],
    mappingField: string,
    read: IRead,
    logger: ILogger,
): Promise<IMapOutput> {
    const results: IMapResult[] = [];
    const warnings: string[] = [];

    // Read raw JSON mapping
    let rawMapping = '';
    try {
        rawMapping = (await read.getEnvironmentReader()
            .getSettings()
            .getValueById('user_mapping_json')) as string;
    } catch (err) {
        logger.warn(`Could not read user_mapping_json: ${err}`);
        warnings.push(`Could not read user_mapping_json: ${err.message}`);
    }

    // Parse JSON mapping
    let userMapping: Record<string, string> = {};
    if (rawMapping) {
        try {
            userMapping = JSON.parse(rawMapping);
        } catch (err) {
            logger.warn(`Invalid user_mapping_json: ${err}`);
            warnings.push(`Invalid JSON in user_mapping_json: ${err.message}`);
        }
    }

    // Map participants to RC users
    for (const participant of participants) {
        let username: string | undefined;
        if (participant[mappingField] && userMapping[participant[mappingField]]) {
            username = userMapping[participant[mappingField]];
        } else {
            username = participant[mappingField];
        }

        if (!username) {
            logger.warn(`Participant missing username: ${JSON.stringify(participant)}`);
            results.push({ participant, error: 'No username' });
            continue;
        }

        try {
            const rcUser = await read.getUserReader().getByUsername(username);
            if (!rcUser) {
                logger.warn(`User not found: ${username}`);
                results.push({ username, participant, error: 'User not found' });
                continue;
            }
            results.push({ username, rcUser, participant });
        } catch (err) {
            logger.error(`Error finding RC user for ${username}: ${err}`);
            results.push({ username, participant, error: String(err) });
        }
    }

    return { results, warnings };
}

/**
 * Sends DMs to mapped Rocket.Chat users. Returns DM results.
 */
export interface ISendDMResult {
    username?: string;
    rcUserId?: string;
    sent: boolean;
    error?: string;
}

export interface ISendDMOutput {
    dmResults: ISendDMResult[];
    warnings: string[];
}

// Constants & Helpers for attachments
const JIRA_LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAACXBIWXMAAAsTAAALEwEAmpwYAAAF8WlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4gPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgNy4yLWMwMDAgNzkuMWI2NWE3OWI0LCAyMDIyLzA2LzEzLTIyOjAxOjAxICAgICAgICAiPiA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iIHhtbG5zOnhtcE1NPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vIiB4bWxuczpzdEV2dD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL3NUeXBlL1Jlc291cmNlRXZlbnQjIiB4bWxuczpkYz0iaHR0cDovL3B1cmwub3JnL2RjL2VsZW1lbnRzLzEuMS8iIHhtbG5zOnBob3Rvc2hvcD0iaHR0cDovL25zLmFkb2JlLmNvbS9waG90b3Nob3AvMS4wLyIgeG1wOkNyZWF0b3JUb29sPSJBZG9iZSBQaG90b3Nob3AgMjQuMCAoTWFjaW50b3NoKSIgeG1wOkNyZWF0ZURhdGU9IjIwMjQtMDMtMjdUMTU6NDc6NDctMDQ6MDAiIHhtcDpNZXRhZGF0YURhdGU9IjIwMjQtMDMtMjdUMTU6NDc6NDctMDQ6MDAiIHhtcDpNb2RpZnlEYXRlPSIyMDI0LTAzLTI3VDE1OjQ3OjQ3LTA0OjAwIiB4bXBNTTpJbnN0YW5jZUlEPSJ4bXAuaWlkOjY5ZTI5ZjAwLTRlZDAtNDI0ZC1hMzBkLTNlOGNmYjdiODVhYyIgeG1wTU06RG9jdW1lbnRJRD0iYWRvYmU6ZG9jaWQ6cGhvdG9zaG9wOjY5ZTI5ZjAwLTRlZDAtNDI0ZC1h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';
const DESC_MAX_LENGTH = 140;

function stripDesc(str?: string): string {
    if (!str) {
        return '';
    }
    return str.length > DESC_MAX_LENGTH
        ? str.slice(0, DESC_MAX_LENGTH - 3) + '...'
        : str;
}

function getAvatarUrl(participant: any): string | undefined {
    // Try direct property
    if (participant?.avatarUrls?.['24x24']) {
        return participant.avatarUrls['24x24'];
    }
    // Try _links.avatarUrls
    if (participant?._links?.avatarUrls?.['24x24']) {
        return participant._links.avatarUrls['24x24'];
    }
    // Try _links.avatarUrls as an object (sometimes it's a string)
    if (typeof participant?._links?.avatarUrls === 'string') {
        return participant._links.avatarUrls;
    }
    return undefined;
}

function prepareAttachment(issue: any, user: any, text: string): IMessageAttachment {
    return {
        author: {
            name: user?.displayName || '',
            icon: getAvatarUrl(user) || '',
        },
        thumbnailUrl: issue.fields.issuetype?.iconUrl || JIRA_LOGO,
        timestamp: new Date(issue.fields.created),
        text,
    };
}

export async function sendDMs(
    mapOutput: IMapOutput,
    issue: any,
    eventType: string,
    modify: IModify,
    read: IRead,
    logger: ILogger,
    data: any, // payload
): Promise<ISendDMOutput> {
    const dmResults: ISendDMResult[] = [];
    const warnings = mapOutput.warnings.slice();
    const { results: rcUserResults } = mapOutput;

    // Read skip_internal_comments setting
    let skipInternal = false;
    try {
        skipInternal = await read.getEnvironmentReader().getSettings().getValueById('skip_internal_comments');
    } catch (e) {
        logger.warn('Could not read skip_internal_comments setting, defaulting to true');
    }

    const appUser = await read.getUserReader().getAppUser();
    if (!appUser) {
        logger.warn('App user is undefined, aborting DM send');
        for (const { username } of rcUserResults) {
            dmResults.push({ username, sent: false, error: 'App user is undefined' });
        }
        return { dmResults, warnings };
    }

    for (const { username, rcUser, error, participant } of rcUserResults) {
        if (!rcUser) {
            dmResults.push({ username, sent: false, error });
            continue;
        }

        // For comment events, skip if comment is internal (public === false) and skipInternal is true
        if (
            skipInternal &&
            (
                eventType === 'issue_commented' ||
                eventType === 'comment_created' ||
                eventType === 'comment_updated' ||
                eventType === 'comment_deleted' ||
                (eventType === 'jira:issue_updated' &&
                    (
                        data.issue_event_type_name === 'issue_commented' ||
                        data.issue_event_type_name === 'issue_comment_deleted' ||
                        data.issue_event_type_name === 'issue_comment_edited'
                    )
                )
            ) &&
            data.comment && data.comment.public === false
        ) {
            // Internal comment, skip DM
            // logger.info('Internal comment, DM not sent.');
            dmResults.push({ username, sent: false, error: 'Internal comment, DM not sent' });
            continue;
        }

        try {
            // Ensure DM room exists
            let room = await read.getRoomReader().getDirectByUsernames([rcUser.username, appUser.username]);
            if (!room) {
                await modify.getCreator().finish(
                    modify.getCreator()
                        .startRoom()
                        .setType(RoomType.DIRECT_MESSAGE)
                        .setCreator(appUser)
                        .setMembersToBeAddedByUsernames([rcUser.username, appUser.username]),
                );
                room = await read.getRoomReader().getDirectByUsernames([rcUser.username, appUser.username]);
            }

            // Build rich summary link
            const baseJiraUrl = issue.self.replace(/\/rest\/.*$/, '');
            const assignee = issue.fields.assignee || {};
            const actorName = data.user?.name;
            const assignedTo = assignee.name && assignee.name !== actorName
                ? `, assigned to ${assignee.displayName}`
                : '';
            const priority = issue.fields.priority?.name.replace(/^\s*\d*\.\s*/, '') || '';
            const summaryLink = `*[${issue.key}](${baseJiraUrl}/browse/${issue.key})* ${issue.fields.summary} _(${priority}${assignedTo})_`;

            // Select attachments based on event
            const attachments: IMessageAttachment[] = [];
            switch (eventType) {
                case 'jira:issue_created':
                    attachments.push(prepareAttachment(
                        issue,
                        participant,
                        `*Created* ${summaryLink}:\n${stripDesc(issue.fields.description)}`,
                    ));
                    break;
                case 'jira:issue_deleted':
                    attachments.push(prepareAttachment(
                        issue,
                        participant,
                        `*Deleted* ${summaryLink}`,
                    ));
                    break;
                case 'jira:issue_updated':
                    if (data.issue_event_type_name === 'issue_commented') {
                        const c = data.comment;
                        attachments.push(prepareAttachment(
                            issue,
                            c.author,
                            `Comment on ${summaryLink}:\n\`\`\`\n${stripDesc(c.body)}\n\`\`\``,
                        ));
                    } else if (data.issue_event_type_name === 'issue_comment_deleted') {
                        const c = data.comment;
                        attachments.push(prepareAttachment(
                            issue,
                            c.author,
                            `Comment deleted for ${summaryLink}:\n\`\`\`\n${stripDesc(c.body)}\n\`\`\``,
                        ));
                    } else if (data.issue_event_type_name === 'issue_comment_edited') {
                        const c = data.comment;
                        attachments.push(prepareAttachment(
                            issue,
                            c.author,
                            `Comment updated for ${summaryLink}:\n\`\`\`\n${stripDesc(c.body)}\n\`\`\``,
                        ));
                    } else if (Array.isArray(data.changelog?.items)) {
                        const logs = data.changelog.items.map((chg: any) =>
                            chg.field === 'description'
                                ? `Changed *description*:\n\`\`\`\n${stripDesc(chg.toString)}\n\`\`\``
                                : `*${chg.field}* changed from ${chg.fromString} to *${chg.toString}*`,
                        ).join('\n  - ');
                        if (logs) {
                            attachments.push(prepareAttachment(
                                issue,
                                participant,
                                `*Updated* ${summaryLink}:\n  - ${logs}`,
                            ));
                        }
                    }
                    break;
                case 'issue_commented':
                case 'comment_created':
                    {
                        const c = data.comment;
                        attachments.push(prepareAttachment(
                            issue,
                            c.author,
                            `Comment created for ${summaryLink}:\n\`\`\`\n${stripDesc(c.body)}\n\`\`\``,
                        ));
                    }
                    break;
                case 'comment_updated':
                    {
                        const c = data.comment;
                        attachments.push(prepareAttachment(
                            issue,
                            c.author,
                            `Comment updated for ${summaryLink}:\n\`\`\`\n${stripDesc(c.body)}\n\`\`\``,
                        ));
                    }
                    break;
                case 'comment_deleted':
                    {
                        const c = data.comment;
                        attachments.push(prepareAttachment(
                            issue,
                            c.author,
                            `Comment deleted for ${summaryLink}:\n\`\`\`\n${stripDesc(c.body)}\n\`\`\``,
                        ));
                    }
                    break;
                default:
                    // no attachments for unhandled events
                    break;
            }

            if (!attachments.length) {
                dmResults.push({ username, sent: false, error: 'No handler for event' });
                continue;
            }

            // Send the DM
            const msg = modify.getCreator().startMessage()
                .setRoom(room!)
                .setSender(appUser)
                .setText('')
                .setAttachments(attachments);
            await modify.getCreator().finish(msg);

            dmResults.push({ username, rcUserId: rcUser.id, sent: true });
        } catch (err) {
            logger.error(`Failed to send DM to ${username}: ${err}`);
            dmResults.push({ username, sent: false, error: err?.message ?? String(err) });
        }
    }
    return { dmResults, warnings };
}


/**
 * Builds the API response for the webhook endpoint.
 */
export function buildResponse({ issueKey, issueSummary, eventType, participants, userMapping, dmResults, warnings }: any) {
    return {
        success: true,
        message: 'Jira webhook received, parsed, and DMs attempted',
        parsed: {
            issueKey,
            eventType,
            participantCount: participants.length,
            totalDMs: dmResults.length,
            sent: dmResults.filter(r => r.sent).length,
            // failed: dmResults.filter(r => !r.sent).length,
            // participants: participants.map((p: any) => ({
            //     displayName: p.displayName,
            //     emailAddress: p.emailAddress,
            //     accountId: p.accountId,
            //     name: p.name,
            //     username: p.name,
            // })),
        },
        // userMapping,
        warnings,
    };
} 