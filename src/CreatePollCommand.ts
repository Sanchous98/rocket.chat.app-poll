import {uuid} from "./lib/uuid";
import {ISlashCommand, SlashCommandContext} from "@rocket.chat/apps-engine/definition/slashcommands";
import {RocketChatAssociationModel, RocketChatAssociationRecord} from "@rocket.chat/apps-engine/definition/metadata";
import {IPoll} from "./definition";
import {createPollBlocks} from "./lib/createPollBlocks";
import {IUser} from "@rocket.chat/apps-engine/definition/users";

const isoDatePattern = /(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2}:?\d{2}|Z)$/

function getOffsetStr(input) {
    const groups = input.match(isoDatePattern);
    return groups ? groups[4] : null;
}

function hasOffset(input) {
    return (!!getOffsetStr(input));
}


class InvalidOptionsError extends Error {
}

class CreatePollOptions {
    public question: string;
    public choices: Array<string> = new Array<string>();
    public isConfidential: boolean = false;
    public showResults: boolean = true;
    public singleChoice: boolean = false;
    public finishAt?: Date

    assert() {
        if (this.question === undefined || this.question.length === 0) {
            throw new InvalidOptionsError('Missing argument "question"');
        }
        if (this.choices === undefined || this.choices.length < 2) {
            throw new InvalidOptionsError('Poll requires at least 2 choices');
        }

        if (this.finishAt !== undefined && this.finishAt < new Date(Date.now())) {
            throw new InvalidOptionsError(`Finish date cannot be in the past`);
        }
    }

    parse(context: SlashCommandContext) {
        for (let param of context.getArguments()) {
            if (param.startsWith("--")) {
                param = param.replace("--", "")
            }

            let [arg, value] = param.split("=", 2);

            switch (arg) {
                case 'question':
                    this.question = value;
                    break;
                case 'choice':
                    this.choices.push(value);
                    break;
                case 'visibility':
                    if (value === undefined) {
                        value = 'open';
                    }

                    this.isConfidential = value === 'confidential';
                    break
                case 'show_results':
                    if (value === undefined) {
                        value = 'always';
                    }

                    this.showResults = value === 'always';
                    break;
                case 'single_choice':
                    if (value === undefined) {
                        value = "true";
                    }

                    this.singleChoice = value.toLowerCase() === "true" || parseInt(value) !== 0;
                    break;
                case 'finish_at':
                    const userUtcOffset = (context.getSender() as IUser).utcOffset
                    this.finishAt = new Date(Date.parse(value) - (hasOffset(value) ? 0 : userUtcOffset * 60 * 60 * 1000));
                    break;
                default:
                    throw new InvalidOptionsError(`${arg} is not supported`);
            }
        }

        this.assert();
    }
}

export class CreatePollCommand implements ISlashCommand {
    public command = 'create_poll';
    public i18nParamsExample = 'params_example';
    public i18nDescription = 'cmd_description';
    public providesPreview = false;

    async executor(context, read, modify, http, persis) {
        const showNames = await read.getEnvironmentReader().getSettings().getById('use-user-name');
        const options = new CreatePollOptions();

        try {
            options.parse(context);
        } catch (e) {
            await modify.getNotifier().notifyUser(
                context.getSender(),
                modify.getCreator().startMessage()
                    .setUsernameAlias((showNames.value && context.getSender().name) || context.getSender().username)
                    .setRoom(context.getRoom())
                    .setText(e.message)
                    .getMessage()
            );
            throw new Error(e);
        }

        const viewId = uuid();
        const poll: IPoll = {
            finished: false,
            totalVotes: 0,
            votes: options.choices.map(() => ({quantity: 0, voters: []})),
            msgId: viewId,
            uid: context.getSender().id,
            question: options.question,
            options: options.choices,
            confidential: options.isConfidential,
            showResults: options.showResults,
            singleChoice: options.singleChoice
        };
        const builder = modify.getCreator().startMessage()
            .setUsernameAlias((showNames.value && context.getSender().name) || context.getSender().username)
            .setRoom(context.getRoom())
            .setText(poll.question);

        if (context.getThreadId()) {
            builder.setThreadId(context.getThreadId());
        }

        const block = modify.getCreator().getBlockBuilder();
        createPollBlocks(block, poll.question, options.choices, poll, options.isConfidential);
        builder.setBlocks(block);

        poll.msgId = await modify.getCreator().finish(builder);
        const pollAssociation = new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, poll.msgId);

        await persis.createWithAssociation(poll, pollAssociation);

        if (options.finishAt === undefined) {
            return;
        }

        await modify.getScheduler().scheduleOnce({
            id: 'poll_timeout',
            when: options.finishAt,
            data: {
                poll: poll,
            }
        })
    }
}
