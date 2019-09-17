var mongoose = require('mongoose');
const Schema = mongoose.Schema;


let UserSchema = new Schema({
    userName:{
        type:String,
    },
    email:{
        type:String,
    },
    password:{
        type:String,
    },
    DOB:{
        type:Date
    }
},{timestamps: { createdAt: 'createdTime', updatedAt: 'updatedTime' }})


var User = mongoose.model('User', UserSchema);

module.exports = {User};
