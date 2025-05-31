import { ApiEndpoint } from '@rocket.chat/apps-engine/definition/api/ApiEndpoint';
import { IApiRequest, IApiResponse } from '@rocket.chat/apps-engine/definition/api';
import { IHttp, IRead, IModify, IPersistence } from '@rocket.chat/apps-engine/definition/accessors';
import { parsePayload, extractParticipants, mapToRCUsers, sendDMs, buildResponse } from './JiraLogic';

export class JiraWebhookEndpoint extends ApiEndpoint {
    public path = 'jira-rc-notifier-webhook';

    public async post(request: IApiRequest, endpoint: any, read: IRead, modify: IModify, http: IHttp, persis: IPersistence): Promise<IApiResponse> {
        const logger = this.app.getLogger();
        logger.info(`Received Jira webhook: ${JSON.stringify(request.content)}`);

        const payload = request.content;
        if (!payload) {
            logger.warn('No payload received');
            return this.success({ success: false, message: 'No payload received' });
        }

        // --- Parse payload ---
        const { issue, fields, issueKey, issueSummary, eventType } = parsePayload(payload);

        // --- Get custom user fields setting ---
        let customFieldsSetting: string | undefined = undefined;
        try {
            customFieldsSetting = await read.getEnvironmentReader().getSettings().getValueById('custom_user_fields');
        } catch (err) {
            logger.warn('Error reading custom user fields setting:', err);
        }

        // --- Extract participants ---
        const uniqueParticipants = extractParticipants(fields, payload, customFieldsSetting);

        // --- Get user mapping and mapping field ---
        let userMapping: Record<string, string> = {};
        try {
            const mappingSetting = await read.getEnvironmentReader().getSettings().getValueById('user_mapping_json');
            if (mappingSetting) {
                userMapping = JSON.parse(mappingSetting);
            }
        } catch (err) {
            logger.warn('Invalid user mapping JSON in settings. Using default mapping.');
        }
        let mappingField = 'name';
        try {
            const fieldSetting = await read.getEnvironmentReader().getSettings().getValueById('user_mapping_field');
            if (fieldSetting && typeof fieldSetting === 'string') {
                mappingField = fieldSetting;
            }
        } catch (err) {
            logger.warn('Error reading user mapping field setting:', err);
        }

        // logger.info('Parsed Jira notification:', JSON.stringify({
        //     issueKey,
        //     issueSummary,
        //     eventType,
        //     participants: uniqueParticipants.map((p: any) => ({
        //         displayName: p.displayName,
        //         emailAddress: p.emailAddress,
        //         accountId: p.accountId,
        //         name: p.name,
        //         username: p.name,
        //     })),
        //     userMapping,
        // }));

        // --- Map to RC users ---
        const mapOutput = await mapToRCUsers(uniqueParticipants, mappingField, read, logger);

        // --- Send DMs ---
        const { dmResults, warnings } = await sendDMs(mapOutput, issue, eventType, modify, read, logger, payload);


        // --- Build and return response ---
        return this.success(buildResponse({
            issueKey,
            issueSummary,
            eventType,
            participants: uniqueParticipants,
            userMapping,
            dmResults,
            warnings
        }));
    }
} 