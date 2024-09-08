import OpenAI from 'openai';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Equal, Repository } from 'typeorm';
import { Socket } from 'socket.io';
import { get_encoding } from 'tiktoken';
import { CreateThreadDto } from './dto/create-thread.dto';
import { UpdateThreadDto } from './dto/update-thread.dto';
import { User } from '../auth/entities/user.entity';
import { PaginationDto } from '../common/dto/pagination.dto';
import { Thread } from './entities/thread.entity';
import { Message } from './entities/message.entity';
import { NewMessageDto } from './dto/new-message.dto';
import { BalanceService } from '../balance/balance.service';
import { system_v1 } from './prompts';
import { initialDateOfMonth, initialDateOfNexMonth } from '../../shared/utils';
import { indentifyLastIntent, getInformationSystemMsg } from './helpers';
import { ActivitiesService } from '../activities/activities.service';
import { CategoriesService } from '../categories/categories.service';
import { GoalsService } from '../goals/goals.service';
import { UpdateMessageDto } from './dto/update-message.dto';
import { ChatMessage } from './helpers/interfaces';
import { actions } from './helpers/actions';

interface ConnectedClients {
  [id: string]: {
    socket: Socket;
    user: User;
  };
}
const MAX_PREVIOUS_MSGS = 8;
const EXTRA_CREDITS = 500;

const INPUT_PRICE_PER_TOKEN = 0.000001; // 	$0.0010 / 1K tokens
const OUTPUT_PRICE_PER_TOKEN = 0.000002; //	$0.0020 / 1K tokens
const CREDITS_PER_INPUT_TOKEN = 1000000 * INPUT_PRICE_PER_TOKEN; // 1 token = 1 credit
const CREDITS_PER_OUTPUT_TOKEN = 1000000 * OUTPUT_PRICE_PER_TOKEN; // 1 token = 2 credits
const intentTokensOutput = 2;

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);
  private openai: OpenAI = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  private connectedClients: ConnectedClients = {};

  constructor(
    @InjectRepository(Thread)
    private readonly threadRepository: Repository<Thread>,
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly balanceService: BalanceService,
    private readonly activitiesService: ActivitiesService,
    private readonly categoriesService: CategoriesService,
    private readonly goalsService: GoalsService,
  ) {}

  async getSuggestions(user: User) {
    return [];
  }

  async createThread(createThreadDto: CreateThreadDto, user: User) {
    try {
      const language = createThreadDto.language || 'en';
      const title = language === 'en' ? 'New chat' : 'Nueva conversación';
      const newThread = this.threadRepository.create({
        title,
        user,
        language,
      });
      await this.threadRepository.save(newThread);
      delete newThread.user;
      return newThread;
    } catch (error) {
      this.handleException(error);
    }
  }

  async findAllThreads(paginationDto: PaginationDto, user: User) {
    const { limit = 10, offset = 0, orderBy, orderDirection } = paginationDto;

    const order = {};
    if (orderBy && orderDirection) {
      order[orderBy] = orderDirection;
    }

    const threads = await this.threadRepository.find({
      where: { user: Equal(user.id) },
      take: limit,
      skip: offset,
      order: order,
    });

    const total = await this.threadRepository.count({
      where: { user: Equal(user.id) },
    });

    return { content: threads, limit, offset, total };
  }

  async findOneThread(id: string, user: User) {
    let thread: Thread = await this.threadRepository
      .createQueryBuilder('thread')
      .leftJoinAndSelect('thread.user', 'user')
      .leftJoinAndSelect('thread.messages', 'message')
      .where('thread.id = :id', { id })
      .andWhere('thread.user.id = :userId', { userId: user.id })
      .orderBy('message.createdAt', 'ASC')
      .getOne();
    if (!thread) {
      throw new NotFoundException(`Thread with id ${id} not found`);
    }
    if (thread.user.id !== user.id) {
      throw new BadRequestException(
        `Thread with id ${id} does not belong to user ${user.id}`,
      );
    }
    delete thread.user;

    return thread;
  }

  async updateThread(id: string, updateThreadDto: UpdateThreadDto, user: User) {
    const thread = await this.findOneThread(id, user);
    Object.assign(thread, updateThreadDto);
    await this.threadRepository.save(thread);
    return thread;
  }

  async removeThread(id: string, user: User) {
    const thread = await this.findOneThread(id, user);
    await this.threadRepository.remove(thread);
  }

  async findOneMessage(threadId: string, messageId: string, user: User) {
    let thread: Thread = await this.threadRepository.findOne({
      where: { id: threadId },
      relations: ['user'],
    });
    if (!thread) {
      throw new NotFoundException(`Thread with id ${threadId} not found`);
    }
    if (thread.user.id !== user.id) {
      throw new BadRequestException(
        `Thread with id ${threadId} does not belong to user ${user.id}`,
      );
    }

    let message: Message = await this.messageRepository.findOne({
      where: { id: messageId },
      relations: ['thread'],
    });
    if (!message) {
      throw new NotFoundException(`Message with id ${messageId} not found`);
    }
    if (message.thread.id !== thread.id) {
      throw new BadRequestException(
        `Message with id ${messageId} does not belong to thread ${thread.id}`,
      );
    }
    return message;
  }

  async updateMessage(
    threadId: string,
    messageId: string,
    updateMessageDto: UpdateMessageDto,
    user: User,
  ) {
    let message: Message = await this.findOneMessage(threadId, messageId, user);
    message = { ...message, ...updateMessageDto };
    await this.messageRepository.save(message);
    return message;
  }

  private handleException(error: any) {
    if (error.code === '23505') {
      throw new BadRequestException(error.detail);
    }

    this.logger.error(error);
    throw new InternalServerErrorException('Error creating goal, check logs');
  }

  // Socket.io connection methods

  async registerClient(client: Socket, userId: string) {
    const user = await this.userRepository.findOneBy({ id: userId });
    if (!user) throw new Error('User not found');
    if (!user.isActive) throw new Error('User not active');

    this.checkUserConnection(user);

    this.connectedClients[client.id] = {
      socket: client,
      user: user,
    };
  }

  removeClient(clientId: string) {
    delete this.connectedClients[clientId];
  }

  async onMessageFromClient(client: Socket, payload: NewMessageDto) {
    const { user } = this.connectedClients[client.id];
    const { threadId, message } = payload;

    const thread = await this.findOneThread(threadId, user);

    const userMessage = this.messageRepository.create({
      role: 'user',
      content: message,
      thread,
    });

    const previousMsgs = thread.messages
      .slice(-MAX_PREVIOUS_MSGS)
      .map(({ role, content }) => ({
        role,
        content,
      }));

    // Identify the user's last intent and map to action
    let intentMsgs: ChatMessage[] = [
      ...previousMsgs.filter(
        (msg) => msg.role === 'user' || msg.content.indexOf('{') !== -1,
      ),
      { role: 'user', content: message },
    ];

    const intentTokensInput = this.countTokens([
      {
        role: 'system',
        content: `
      Identify the user intent and return ONLY the intent value
      [${actions.join(', ')}]
        `,
      },
      ...intentMsgs,
    ]);

    if (
      intentTokensInput * CREDITS_PER_INPUT_TOKEN >
      user.credits + EXTRA_CREDITS
    ) {
      client.emit('not-enough-credits', {
        queryTokensInput: intentTokensInput,
        userCredits: user.credits,
        userMessage,
      });
      return;
    }

    await this.messageRepository.save(userMessage);

    client.emit('user-message-complete', userMessage);

    const intent = await indentifyLastIntent(this.openai, intentMsgs);

    const fromDate = initialDateOfMonth(new Date());
    const toDate = initialDateOfNexMonth(new Date());
    const resume = await this.balanceService.getResumeV1(
      { fromDate, toDate },
      user,
    );

    // Create a system message for the assistant
    let currentMsgs: ChatMessage[] = [];

    let systemMsg: OpenAI.Chat.Completions.ChatCompletionMessageParam;
    if (intent === 'other' || intent === 'question') {
      systemMsg = {
        role: 'system',
        content: system_v1 + '\n\n **User data:**\n\n' + JSON.stringify(resume),
      };
      currentMsgs = [
        systemMsg,
        ...previousMsgs,
        { role: 'user', content: message },
      ];
    } else {
      const infoMsg = await getInformationSystemMsg(
        intent,
        this.balanceService,
        this.activitiesService,
        this.categoriesService,
        this.goalsService,
        user,
      );
      systemMsg = {
        role: 'system',
        content: infoMsg,
      };

      currentMsgs = [systemMsg, ...intentMsgs];
    }

    const queryTokensInput = this.countTokens(currentMsgs);

    if (
      (queryTokensInput + intentTokensInput) * CREDITS_PER_INPUT_TOKEN >
      user.credits + EXTRA_CREDITS
    ) {
      client.emit('not-enough-credits', {
        queryTokensInput: queryTokensInput + intentTokensInput,
        userCredits: user.credits,
        userMessage,
      });
      return;
    }

    client.emit('assistant-message-created');
    // Send the new message to the OpenAI API and stream the response.
    const stream = await this.openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: currentMsgs,
      stream: true,
    });

    let completeMessage = '';
    const assistantMessage = this.messageRepository.create({
      role: 'assistant',
      content: completeMessage,
      thread,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      completeMessage += content;
      client.emit('assistant-message-chunk', completeMessage);
    }

    // Save complete message to the database.
    assistantMessage.content = completeMessage;
    await this.messageRepository.save(assistantMessage);
    client.emit('assistant-message-complete', assistantMessage);

    const queryTokensOutput = this.countTokens([
      { role: 'assistant', content: completeMessage },
    ]);

    user.credits -= intentTokensInput * CREDITS_PER_INPUT_TOKEN;
    user.credits -= intentTokensOutput * CREDITS_PER_OUTPUT_TOKEN;
    user.credits -= queryTokensInput * CREDITS_PER_INPUT_TOKEN;
    user.credits -= queryTokensOutput * CREDITS_PER_OUTPUT_TOKEN;
    await this.userRepository.save(user);

    // Generate a title for the thread.
    if (previousMsgs.length == 2) {
      const whatWouldBeAGoodTittle =
        thread.language === 'en'
          ? 'What would be as good title for this conversation?'
          : 'Cual sería un buen título para esta conversación?';

      const titleMessages: ChatMessage[] = [
        ...previousMsgs,
        { role: 'user', content: message },
        { role: 'assistant', content: completeMessage },
        { role: 'user', content: whatWouldBeAGoodTittle },
      ];

      const titleTokensInput = this.countTokens(titleMessages);

      const res = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: titleMessages,
      });

      const title = res.choices[0]?.message.content;

      if (title) {
        await this.threadRepository.update(thread.id, { title });
        client.emit('thread-title-updated', title);

        const titleTokensOutput = this.countTokens([
          { role: 'assistant', content: title },
        ]);
        user.credits -= titleTokensOutput * CREDITS_PER_OUTPUT_TOKEN;
      }

      user.credits -= titleTokensInput * CREDITS_PER_INPUT_TOKEN;
      await this.userRepository.save(user);
    }

    client.emit('update-user-credits', { userCredits: user.credits });
  }

  private checkUserConnection(user: User) {
    for (const clientId of Object.keys(this.connectedClients)) {
      const connectedClient = this.connectedClients[clientId];

      if (connectedClient.user.id === user.id) {
        connectedClient.socket.disconnect();
        break;
      }
    }
  }

  private countTokens(messages: ChatMessage[]) {
    const encoding = get_encoding('cl100k_base');
    let allWords = messages.map((msg) => msg.content).join(' ');
    const credits = encoding.encode(allWords).length;
    encoding.free();
    return credits;
  }
}
