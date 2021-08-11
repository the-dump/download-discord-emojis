"use strict";

const https = require("https");
const crypto = require("crypto");
const zlib = require("zlib");

const { Readable } = require("stream");
const { Client, Intents } = require("discord.js");

const config = require("./config.json");
const { create } = require("domain");

const TAR_FILE_MODE = 420;
const TAR_DIR_FILE_MODE = 493;
const TAR_USER_ID = 0;
const TAR_GROUP_ID = 0;
const TAR_FILE_SIZE_LIMIT = 0x1ffffffff;
const TAR_HEADER_LENGTH = 512;

const FINISHED_GZIP_TAR_EXT = "tar.gz";
const FINISHED_GZIP_TAR_NAME_LENGTH = 16;

const EMOJIS_ROOT_DIR = "emojis";
const EMOJIS_IMAGES_DIR = "images";
const EMOJIS_ANIMTAED_DIR = "animated";

const CDN_IMAGE_EXT = "png";
const CDN_ANIMATED_EXT = "gif";
const CDN_PREFIX = "https://cdn.discordapp.com/emojis";

const PROMPT = "download emojis please";

function constructTarHeader(fileName, fileSize, fileMode)
{
    const string = (s, bytes) =>
    {
        bytes = Math.max(bytes - 1, 0);
        
        const buffer = Buffer.from(s.substr(0, Math.min(s.length, bytes)));
        const padding = Buffer.alloc(Math.max(bytes - s.length, 0));

        return Buffer.concat([buffer, padding, Buffer.from("\x00")]);
    };
    
    const octal = (number, bytes) =>
    {
        bytes = Math.max(bytes - 1, 0);
        
        const s = number.toString(8).padStart(bytes, "0");
        const buffer = Buffer.from(s.substr(0, Math.min(s.length, bytes)));

        return Buffer.concat([buffer, Buffer.from(" ")]);
    };

    const fileSizeTruncated = Math.min(fileSize, TAR_FILE_SIZE_LIMIT);
    const timeStamp = Date.now() / 1000;
    
    const buffer = Buffer.concat
    ([
        string(fileName, 100),
        octal(fileMode, 8),
        octal(TAR_USER_ID, 8),
        octal(TAR_GROUP_ID, 8),
        octal(fileSizeTruncated, 12),
        octal(timeStamp, 12),
        Buffer.alloc(8, " "),
        Buffer.alloc(1, "\x00"),
        Buffer.alloc(100),
    ]);
    
    let checksum = 0;

    for (let index = 0; index < buffer.length; ++index)
    {
        checksum += buffer.readUInt8(index);
    }
    
    const checksumBuffer = octal(checksum, 8);
    checksumBuffer.copy(buffer, 148);

    return Buffer.concat([ buffer, Buffer.alloc(TAR_HEADER_LENGTH - buffer.length, "\x00") ]);
}

function sanatizefilePath(filePath)
{
    const components = filePath.split("/");
    const strings = [];
    
    for (let index = 0; index < components.length; ++index)
    {
        const component = components[index];
        
        if (component === "." || component === ".." || component === "/")
        {
            continue;
        }

        strings.push(component);
    }
    
    return strings.join("/");
}

function getAllDirPaths(filePaths)
{
    const dirPaths = {};

    for (let index1 = 0; index1 < filePaths.length; ++index1)
    {
        const filePath = filePaths[index1];
        const components = filePath.split("/");
        
        const dirPathComponents = [];

        for (let index2 = 0; index2 < Math.max(components.length - 1, 0); ++index2)
        {
            dirPathComponents.push(components[index2]);
            const dirPath = dirPathComponents.join("/");
            
            dirPaths[dirPath] = null;
        }
    }
    
    return Object.keys(dirPaths);
}

function formatTarDirFilePath(dirPath)
{
    return `${dirPath}/`;
}

function constructTarDirHeaderBuffers(filePaths)
{
    const filePathsSanatised = filePaths.map(sanatizefilePath);

    const buffers = [];
    const dirPaths = getAllDirPaths(filePathsSanatised);

    for (let index = 0; index < dirPaths.length; ++index)
    {
        const dirPath = dirPaths[index];
        const tarDirFilePath = formatTarDirFilePath(dirPath);

        buffers.push(constructTarHeader(tarDirFilePath, 0, TAR_DIR_FILE_MODE));
    }
    
    return buffers;
}

function constructIndividualTarFileBuffers(filePath, fileBuffer)
{
    const filePathSanatised = sanatizefilePath(filePath);
    const remaining = TAR_HEADER_LENGTH - fileBuffer.length % TAR_HEADER_LENGTH;

    const buffers =
    [
        constructTarHeader(filePathSanatised, fileBuffer.length, TAR_FILE_MODE),
        fileBuffer,
        Buffer.alloc(remaining, "\x00"),
    ];
    
    return buffers;
}

function find(s, target, start, a, b)
{
    const index = s.indexOf(target, start + a);
    
    if (index !== -1)
    {
        return index + b;
    }

    return +Infinity;
}

function getEmojisFromMessageContent(messageContent)
{
    const emojis = [];
    
    for (let index1 = 0; true; ++index1)
    {
        let index2 = find(messageContent, "<", index1, 0, 1);
        let index3 = find(messageContent, ":", index2, 0, 0);
        let index4 = find(messageContent, "", index3, 1, 0);
        let index5 = find(messageContent, ":", index4, 0, 0);
        let index6 = find(messageContent, "", index5, 1, 0);
        let index7 = find(messageContent, ">", index6, 0, 0);
        
        const emojiAnimated = messageContent.slice(index2, index3).trim() === "a";
        const emojiName = messageContent.slice(index4, index5).trim();   
        const emojiId = messageContent.slice(index6, index7).trim();
        
        const emoji =
        {
            animated: emojiAnimated,
            name: emojiName,
            id: emojiId,
        };

        if (index7 < messageContent.length)
        {
            emojis.push(emoji);
        }

        index1 = find(messageContent, "", index6, 1, 0);
        
        if (index1 >= messageContent.length)
        {
            break;
        }
    }
    
    return emojis;
}

function getMessageEmojis(message)
{
    const object = {};
    const emojis = getEmojisFromMessageContent(message.content);

    for (let index = 0; index < emojis.length; ++index)
    {
        const emoji = emojis[index];
        object[emoji.id] = emoji;
    }
    
    return Object.values(object);
}

function formatEmojiCdnFilename(emoji)
{
    let ext = CDN_IMAGE_EXT;

    if (emoji.animated)
    {
        ext = CDN_ANIMATED_EXT;
    }
    
    return `${emoji.id}.${ext}`;
}

function formatEmojiTarFilePath(emoji)
{
    let subdir = EMOJIS_IMAGES_DIR;
    let ext = CDN_IMAGE_EXT;

    if (emoji.animated)
    {
        subdir = EMOJIS_ANIMTAED_DIR;
        ext = CDN_ANIMATED_EXT;
    }

    return `${EMOJIS_ROOT_DIR}/${subdir}/${emoji.name}-${emoji.id}.${ext}`;
}

function formatFinishedTarFilename()
{
    const buffer = crypto.randomBytes(FINISHED_GZIP_TAR_NAME_LENGTH);
    const name = buffer.toString("hex");
    
    return `${name}.${FINISHED_GZIP_TAR_EXT}`;
}

function replyWithArchivedEmojisImpl2(message, tarBuffers)
{
    class BuffersJoinedStream extends Readable
    {
        constructor(buffers, options)
        {
            super(options);

            this.index = 0;
            this.buffersIndex = 0;
            
            this.buffers = buffers;
        }

        _read(size)
        {
            let chunk = null;
            
            if (this.buffersIndex !== this.buffers.length)
            {
                const buffer = this.buffers[this.buffersIndex];
                
                const end = this.index + Math.min(size, buffer.length - this.index);
                const slice = buffer.slice(this.index, end);
                
                this.index += slice.length;
                
                if (this.index === buffer.length)
                {
                    this.index = 0;
                    this.buffersIndex += 1;
                }
                
                chunk = slice;
            }

            this.push(chunk);
        }
    };
    
    const readStream = new BuffersJoinedStream(tarBuffers);
    const gzipStream = zlib.createGzip();

    readStream.on("error", console.error);
    gzipStream.on("error", console.error);

    readStream.pipe(gzipStream);
    
    readStream.on("end", () =>
    {
        gzipStream.end();
    });
    
    const gzipBuffers = [];

    gzipStream.on("data", (chunk) =>
    {
        gzipBuffers.push(chunk);
    });
    
    gzipStream.on("end", () =>
    {
        message.reply
        ({
            files:
            [{
                name: formatFinishedTarFilename(),
                attachment: Buffer.concat(gzipBuffers),
            }]
        });
    });
}

function replyWithArchivedEmojisImpl1(message)
{
    const emojis = getMessageEmojis(message);
    const filePaths = emojis.map((emoji) => formatEmojiTarFilePath(emoji));
    
    const tarBuffers = constructTarDirHeaderBuffers(filePaths);
    let fileCount = 0;
    
    for (let index = 0; index < emojis.length; ++index)
    {
        const emoji = emojis[index];

        const cdnFilename = formatEmojiCdnFilename(emoji);
        const url = `${CDN_PREFIX}/${cdnFilename}`;
        
        let cancel = false;
        
        const request = https.get(url, (response) =>
        {
            if (response.statusCode !== 200)
            {
                return;
            }

            const buffers = [];

            response.on("data", (chunk) =>
            {
                if (cancel)
                {
                    return response.destroy();
                }
                
                buffers.push(chunk);
            });

            response.on("end", () =>
            {
                if (cancel)
                {
                    return response.destroy();
                }

                const filePath = formatEmojiTarFilePath(emoji);
                const fileBuffer = Buffer.concat(buffers);
                
                const tarFileBuffers = constructIndividualTarFileBuffers(filePath, fileBuffer);
                
                tarBuffers.push(...tarFileBuffers);
                fileCount += 1;
                
                if (fileCount >= emojis.length)
                {
                    replyWithArchivedEmojisImpl2(message, tarBuffers);
                }
            });
        });
        
        request.on("error", (error) =>
        {
            cancel = true;
            console.error(error);
        });
        
        request.end();
    }

}

function replyWithArchivedEmojis(collection)
{
    if (collection.length === 0)
    {
        return;
    }

    const iter = collection.values();
    const value = iter.next().value;
    
    return replyWithArchivedEmojisImpl1(value);
}

function createBot()
{    
    const bot = new Client
    ({
        intents:
        [
            Intents.FLAGS.GUILDS,
            Intents.FLAGS.GUILD_MESSAGES,
        ]
    });
    
    bot.on("messageCreate", (message) =>
    {
        if (message.content === PROMPT && message.reference !== null)
        {
            const messages = message.channel.messages;
            const messageId = message.reference.messageId;    
            
            const options =
            {
                around: messageId,
                limit: 1,
            };

            messages.fetch(options)
                .then(replyWithArchivedEmojis)
                .catch(console.error);    
        }
    });

    return bot;
}

createBot().login(config.token);
