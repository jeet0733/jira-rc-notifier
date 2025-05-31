import {
    IAppAccessors,
    ILogger,
    IConfigurationExtend,
} from '@rocket.chat/apps-engine/definition/accessors';
import { App } from '@rocket.chat/apps-engine/definition/App';
import { IAppInfo } from '@rocket.chat/apps-engine/definition/metadata';
import { JiraWebhookEndpoint } from './endpoints/JiraWebhookEndpoint';
import { ApiVisibility, ApiSecurity } from '@rocket.chat/apps-engine/definition/api';
import { SettingType } from '@rocket.chat/apps-engine/definition/settings/SettingType';

export class JiraNotifierApp extends App {
    constructor(info: IAppInfo, logger: ILogger, accessors: IAppAccessors) {
        super(info, logger, accessors);
    }

    public async extendConfiguration(configuration: IConfigurationExtend): Promise<void> {
        await configuration.api.provideApi({
            visibility: ApiVisibility.PUBLIC,
            security: ApiSecurity.UNSECURE,
            endpoints: [new JiraWebhookEndpoint(this)],
        });
        
        await configuration.settings.provideSetting({
            id: 'user_mapping_field',
            type: SettingType.SELECT,
            packageValue: 'name',
            required: false,
            public: false,
            i18nLabel: 'Jira User Field for Mapping',
            i18nDescription: 'Select which Jira field to match with Rocket.Chat users.',
            values: [
                { key: 'name', i18nLabel: 'Username' },
                { key: 'emailAddress', i18nLabel: 'Email' },
            ],
        });
        
        await configuration.settings.provideSetting({
            id: 'user_mapping_json',
            type: SettingType.STRING,
            packageValue: '{}',
            required: false,
            public: false,
            i18nLabel: 'User Mapping (Jira → Rocket.Chat) in JSON format',
            i18nDescription: 'Map Jira usernames to Rocket.Chat usernames in JSON format. Example: { "jirauser": "rcuser" }',
        });
        
        await configuration.settings.provideSetting({
            id: 'custom_user_fields',
            type: SettingType.STRING,
            packageValue: '',
            required: false,
            public: false,
            i18nLabel: 'Jira Custom User Fields',
            i18nDescription: 'Comma-separated list of custom field keys to check for users.\n\nExample: customfield_10201,customfield_11902,customfield_10200',
        });
        
        await configuration.settings.provideSetting({
            id: 'skip_internal_comments',
            type: SettingType.BOOLEAN,
            packageValue: false,
            required: false,
            public: false,
            i18nLabel: 'Do not send internal comments to all participants. (Only works with Jira Cloud)',
            i18nDescription: 'If checked, internal (non-public) comments will not be sent as DMs. Only works if Jira webhook includes the "public" field.'
        });
    }
}
