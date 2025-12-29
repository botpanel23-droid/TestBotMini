// plugins/menu.js
module.exports = {
    name: 'menu',
    description: 'Display bot menu',
    async execute(socket, msg, args, helpers) {
        const { config, formatMessage, sender, myquoted } = helpers;
        
        const menuText = `╭━━━━━━━━━━━━━━━━━━━━━━━╮
┃     *${config.BOT_NAME}*     
┃━━━━━━━━━━━━━━━━━━━━━━━┃
┃ 🌐 *Connect Portal*
┃ https://didula-md.free.nf
╰━━━━━━━━━━━━━━━━━━━━━━━╯

[Menu content here...]

╭━━━━━━━━━━━━━━━━━━━━━━━╮
┃  *© 2025 ${config.OWNER_NAME}*
┃  *${config.TEAM_NAME}*
╰━━━━━━━━━━━━━━━━━━━━━━━╯`;
        
        await socket.sendMessage(sender, {
            image: { url: config.IMAGE_PATH },
            caption: menuText
        }, { quoted: myquoted });
    }
};
