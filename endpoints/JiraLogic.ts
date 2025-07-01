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
    //      • OR "approval" objects, which themselves contain an array of { approver: {…} }.
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
                // Check if each item looks like an "approval" object (has .approvers array)
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
                    // Otherwise, assume it's a plain array of user-objects
                    participants = participants.concat(value as any[]);
                }
            }
            // If this field is a single object:
            else if (value && typeof value === 'object') {
                // Maybe it's an "approval" object with array .approvers
                if (Array.isArray((value as any).approvers)) {
                    for (const approverWrapper of (value as any).approvers) {
                        if (approverWrapper && (approverWrapper as any).approver) {
                            participants.push((approverWrapper as any).approver);
                        }
                    }
                }
                // Otherwise assume it's one user-object
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
        // Build a dedupe-key; if accountId is missing we fall back to emailAddress or name.
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
const JIRA_LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAMAAADW3miqAAAA0lBMVEUAAADZNDF6iJqCjpl/i5eAi5eBjZiCjJeCjpqDjpqBjZkrf/wpfe3WNzbWOTjWODfWOTjTOTrVOjnWOjnVOjnWOjjWOTfWOTjWOTjWOzuAi5c9T2I+UWU+UWU+UWY/U2c+UmY/Umc8UGcsdtRRhcopffwsf/4ogPUpgPoogfIngfIngfJ5jKIyguoogPYpgPgngPQhgfotgP8pgfUgfP0ugv0tgP0vgv0tgf7VNjYsgfovgv8wgv8ugvwoffqCjppchcJkZZOCjpqBjJiBjZqXUHDk1yTnAAAARnRSTlMACAORKg1kFKDmXiMoIWY2eS20waqZRlGL+zEhQWeP/rXbDXjH/v81Pcjx/2urL1qDEZrXC9+uIb4SSf/zawKDBgRzeU4B9OegkQAAAbhJREFUeNrt0GmPmkAcx/Efjqzuityo6+22e3ijKBUQOef9v6UywcK026RP+2C/JJP8kw+ZA/9zP/zk3+ZyDW/V1JVVWRE+myDglPxcZA7UfvdPwylBfzYGsqxahirw5ug7tdIM2UMRVXSVcuaAj3OlLBWCQNnXNbQS+cVOe+DkBoF7KnfrQVU1s2v1YfZL1Aivwdk/Hd/eLh2wqCVDUby+1+t6hoIyypT7ejdSBz3jfi1vYAngVPDKTLzzXcf3dE3paZoi65YH8IqZd/d8vgZHzTB1U9fNQU8AeOUWxne2vmQfD5ope4nnlYIvAaTLHsApBhVQREcjVDWze9vvbE1b97/Gi8W4Qg+PJGdttmxtP+YADgdgOptNahSRHEUfezYQNrwvlz7G8/moRk8t8tAo0A5xGolpgez1evsymU7HSY3QitIY8U2MMhEM7VercDIrmnAIYpuIaLXbMcBQx7alKUPzpEbJhmQkJyl5ogz5zmrlfJsvFosJrVCSRSJykqNFNjTNT8t1kSONRi/1wVN2ojIxS6P8UKIOAP6dhs1fDdk7SaFth7sbuIZt8ltN/C3a4KP46lM/AZ74R/fik8COAAAAAElFTkSuQmCC';
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

/**
 * Builds the appropriate ticket URL for Service Desk or classic Jira tickets.
 * Tries to find Service Desk portal URL, falls back to classic Jira browse URL.
 */
function buildTicketUrl(issue: any, baseJiraUrl: string): string {
    // Check if this is a Service Desk project
    if (issue.fields.project?.projectTypeKey === 'service_desk') {
        // Look for any field that contains requestType with serviceDeskId
        for (const [fieldName, fieldValue] of Object.entries(issue.fields)) {
            if (
                fieldValue &&
                typeof fieldValue === 'object' &&
                (fieldValue as any).requestType &&
                typeof (fieldValue as any).requestType.serviceDeskId === 'string'
            ) {
                // Found Service Desk field with portal ID
                const portalId = (fieldValue as any).requestType.serviceDeskId;
                return `${baseJiraUrl}/servicedesk/customer/portal/${portalId}/${issue.key}`;
            }
        }
    }
    
    // Fallback to classic Jira browse URL
    return `${baseJiraUrl}/browse/${issue.key}`;
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
                ? `, assigned to *${assignee.displayName}*`
                : '';
            const priority = issue.fields.priority?.name.replace(/^\s*\d*\.\s*/, '') || '';
            const ticketUrl = buildTicketUrl(issue, baseJiraUrl);
            const summaryLink = `*[${issue.key}](${ticketUrl})* ${issue.fields.summary} _(${priority}${assignedTo})_`;

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