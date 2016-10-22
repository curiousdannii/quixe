(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.ZVM = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
/*

Abstract syntax trees for IF VMs
================================

Copyright (c) 2016 The ifvms.js team
BSD licenced
http://github.com/curiousdannii/ifvms.js

*/

/*

All AST nodes must use these functions, even constants
(An exception is made for branch addresses and text literals which remain as primitives)
toString() functions are used to generate JIT code

Aside from Variable is currently generic and could be used for Glulx too

TODO:
	Use strict mode for new Function()?
	When we can run through a whole game, test whether using common_func is faster (if its slower then not worth the file size saving)
	Can we eliminate the Operand class?
	Subclass Operand/Variable from Number?
	Replace calls to args() with arguments.join()?

*/

var utils = require( '../common/utils.js' ),
Class = utils.Class,
U2S = utils.U2S16,
//S2U = utils.S2U16;

// Generic/constant operand
// Value is a constant
Operand = Class.subClass({
	init: function( engine, value )
	{
		this.e = engine;
		this.v = value;
	},
	toString: function()
	{
		return this.v;
	},

	// Convert an Operand into a signed operand
	U2S: function()
	{
		return U2S( this.v );
	},
}),

// Variable operand
// Value is the variable number
// TODO: unrolling is needed -> retain immediate returns if optimisations are disabled
Variable = Operand.subClass({
	// Get a value
	toString: function()
	{
		var variable = this.v;

		// Indirect
		if ( this.indirect )
		{
			return 'e.indirect(' + variable + ')';
		}

		// Stack
		if ( variable === 0 )
		{
			// If we've been passed a value we're setting a variable
			return 's.pop()';
		}
		// Locals
		if ( --variable < 15 )
		{
			return 'l[' + variable + ']';
		}
		// Globals
		return 'm.getUint16(' + ( this.e.globals + ( variable - 15 ) * 2 ) + ')';
	},

	// Store a value
	store: function( value )
	{
		var variable = this.v;

		// Indirect variable
		if ( this.indirect )
		{
			return 'e.indirect(' + variable + ',' + value + ')';
		}

		// BrancherStorers need the value
		if ( this.returnval )
		{
			return 'e.variable(' + variable + ',' + value + ')';
		}

		// Stack
		if ( variable === 0 )
		{
			// If we've been passed a value we're setting a variable
			return 's.push(' + value + ')';
		}
		// Locals
		if ( --variable < 15 )
		{
			return 'l[' + variable + ']=' + value;
		}
		// Globals
		return 'm.setUint16(' + ( this.e.globals + ( variable - 15 ) * 2 ) + ',' + value + ')';
	},

	// Convert an Operand into a signed operand
	U2S: function()
	{
		return 'e.U2S(' + this + ')';
	},
}),

// Generic opcode
// .func() must be set, which returns what .write() will actually return; it is passed the operands as its arguments
Opcode = Class.subClass({
	init: function( engine, context, code, pc, next, operands )
	{
		this.e = engine;
		this.context = context;
		this.code = code;
		this.pc = pc;
		this.labels = [ this.pc + '/' + this.code ];
		this.next = next;
		this.operands = operands;

		// Post-init function (so that they don't all have to call _super)
		if ( this.post )
		{
			this.post();
		}
	},

	// Write out the opcode, passing .operands to .func(), with a JS comment of the pc/opcode
	toString: function()
	{
		return this.label() + ( this.func ? this.func.apply( this, this.operands ) : '' );
	},

	// Return a string of the operands separated by commas
	args: function( joiner )
	{
		return this.operands.join( joiner );
	},

	// Generate a comment of the pc and code, possibly for more than one opcode
	label: function()
	{
		return '/* ' + this.labels.join() + ' */ ';
	},
}),

// Stopping opcodes
Stopper = Opcode.subClass({
	stopper: 1,
}),

// Pausing opcodes (ie, set the pc at the end of the context)
Pauser = Stopper.subClass({
	storer: 1,

	post: function()
	{
		this.storer = this.operands.pop();
		this.origfunc = this.func;
		this.func = this.newfunc;
	},

	newfunc: function()
	{
		return 'e.pc=' + this.next + ';' + this.origfunc.apply( this, arguments );
	},
}),

// Join multiple branchers together with varying logic conditions
BrancherLogic = Class.subClass({
	init: function( ops, code )
	{
		this.ops = ops || [];
		this.code = code || '||';
	},

	toString: function()
	{
		var i = 0,
		ops = [],
		op;
		while ( i < this.ops.length )
		{
			op = this.ops[i++];
			// Accept either Opcodes or further BrancherLogics
			ops.push(
				op.func ?
					( op.iftrue ? '' : '!(' ) + op.func.apply( op, op.operands ) + ( op.iftrue ? '' : ')' ) :
					op
			);
		}
		return ( this.invert ? '(!(' : '(' ) + ops.join( this.code ) + ( this.invert ? '))' : ')' );
	},
}),

// Branching opcodes
Brancher = Opcode.subClass({
	// Flag for the disassembler
	brancher: 1,

	keyword: 'if',

	// Process the branch result now
	post: function()
	{
		var result,
		prev,

		// Calculate the offset
		brancher = this.operands.pop(),
		offset = brancher[1];
		this.iftrue = brancher[0];

		// Process the offset
		if ( offset === 0 || offset === 1 )
		{
			result = 'e.ret(' + offset + ')';
		}
		else
		{
			offset += this.next - 2;

			// Add this target to this context's list
			this.context.targets.push( offset );
			result = 'e.pc=' + offset;
		}

		this.result = result + ';return';
		this.offset = offset;
		this.cond = new BrancherLogic( [this] );

		// TODO: re-enable
		/*if ( this.e.env.debug )
		{
			// Stop if we must
			if ( debugflags.noidioms )
			{
				return;
			}
		}*/

		// Compare with previous statement
		if ( this.context.ops.length )
		{
			prev = this.context.ops.pop();
			// As long as no other opcodes have an offset property we can skip the instanceof check
			if ( /* prev instanceof Brancher && */ prev.offset === offset )
			{
				// Goes to same offset so reuse the Brancher arrays
				this.cond.ops.unshift( prev.cond );
				this.labels = prev.labels;
				this.labels.push( this.pc + '/' + this.code );
			}
			else
			{
				this.context.ops.push( prev );
			}
		}
	},

	// Write out the brancher
	toString: function()
	{
		var result = this.result;

		// Account for Contexts
		if ( result instanceof Context )
		{
			// Update the context to be a child of this context
			if ( this.e.env.debug )
			{
				result.context = this.context;
			}

			result = result + ( result.stopper ? '; return' : '' );

			// Extra line breaks for multi-op results
			if ( this.result.ops.length > 1 )
			{
				result = '\n' + result + '\n';
				if ( this.e.env.debug )
				{
					result += this.context.spacer;
				}
			}
		}

		// Print out a label for all included branches and the branch itself
		return this.label() + this.keyword + this.cond + ' {' + result + '}';
	},
}),

// Brancher + Storer
BrancherStorer = Brancher.subClass({
	storer: 1,

	// Set aside the storer operand
	post: function()
	{
		BrancherStorer.super.post.call( this );
		this.storer = this.operands.pop();
		this.storer.returnval = 1;

		// Replace the func
		this.origfunc = this.func;
		this.func = this.newfunc;
	},

	newfunc: function()
	{
		return this.storer.store( this.origfunc.apply( this, arguments ) );
	},
}),

// Storing opcodes
Storer = Opcode.subClass({
	// Flag for the disassembler
	storer: 1,

	// Set aside the storer operand
	post: function()
	{
		this.storer = this.operands.pop();
	},

	// Write out the opcode, passing it to the storer (if there still is one)
	toString: function()
	{
		var data = Storer.super.toString.call( this );

		// If we still have a storer operand, use it
		// Otherwise (if it's been removed due to optimisations) just return func()
		return this.storer ? this.storer.store( data ) : data;
	},
}),

// Routine calling opcodes
Caller = Stopper.subClass({
	// Fake a result variable
	result: { v: -1 },

	// Write out the opcode
	toString: function()
	{
		// TODO: Debug: include label if possible
		return this.label() + 'e.call(' + this.operands.shift() + ',' + this.result.v + ',' + this.next + ',[' + this.args() + '])';
	},
}),

// Routine calling opcodes, storing the result
CallerStorer = Caller.subClass({
	// Flag for the disassembler
	storer: 1,

	post: function()
	{
		// We can't let the storer be optimised away here
		this.result = this.operands.pop();
	},
}),

// A generic context (a routine, loop body etc)
Context = Class.subClass({
	init: function( engine, pc )
	{
		this.e = engine;
		this.pc = pc;
		this.pre = [];
		this.ops = [];
		this.post = [];
		this.targets = []; // Branch targets
		if ( engine.env.debug )
		{
			this.spacer = '';
		}
	},

	toString: function()
	{
		if ( this.e.env.debug )
		{
			// Indent the spacer further if needed
			if ( this.context )
			{
				this.spacer = this.context.spacer + '  ';
			}
			// DEBUG: Pretty print!
			return this.pre.join( '' ) + ( this.ops.length > 1 ? this.spacer : '' ) + this.ops.join( ';\n' + this.spacer ) + this.post.join( '' );

		}
		else
		{
			// Return the code
			return this.pre.join( '' ) + this.ops.join( ';' ) + this.post.join( '' );
		}
	},
}),

// A routine body
RoutineContext = Context.subClass({
	toString: function()
	{
		// TODO: Debug: If we have routine names, find this one's name

		// Add in some extra vars and return
		this.pre.unshift( 'var l=e.l,m=e.m,s=e.s;\n' );
		return RoutineContext.super.toString.call( this );
	},
});

// Opcode builder
// Easily build a new opcode from a class
function opcode_builder( Class, func, flags )
{
	flags = flags || {};
	if ( func )
	{
		/*if ( func.pop )
		{
			flags.str = func;
			flags.func = common_func;
		}
		else
		{*/
		flags.func = func;
		//}
	}
	return Class.subClass( flags );
}

module.exports = {
	Operand: Operand,
	Variable: Variable,
	Opcode: Opcode,
	Stopper: Stopper,
	Pauser: Pauser,
	BrancherLogic: BrancherLogic,
	Brancher: Brancher,
	BrancherStorer: BrancherStorer,
	Storer: Storer,
	Caller: Caller,
	CallerStorer: CallerStorer,
	Context: Context,
	RoutineContext: RoutineContext,
	opcode_builder: opcode_builder,
};

},{"../common/utils.js":3}],2:[function(require,module,exports){
/*

File classes
============

Copyright (c) 2016 The ifvms.js team
BSD licenced
http://github.com/curiousdannii/ifvms.js

*/

function string_to_Uint32( str, offset )
{
	return str.charCodeAt( offset ) << 24 | str.charCodeAt( offset + 1 ) << 16 | str.charCodeAt( offset + 2 ) << 8 | str.charCodeAt( offset + 3 );
}

function Uint32_to_string( num )
{
	return String.fromCharCode.call( null, ( num >> 24 ) & 0xFF, ( num >> 16 ) & 0xFF, ( num >> 8 ) & 0xFF, num & 0xFF );
}

var utils = require( './utils.js' ),
Class = utils.Class,

// A basic IFF file, to be extended later
// Currently supports string data
IFF = Class.subClass({
	init: function( data )
	{
		this.type = '';
		this.chunks = [];
		if ( data )
		{
			// Check that it is actually an IFF file
			if ( data.substr( 0, 4 ) !== 'FORM' )
			{
				throw new Error( 'Not an IFF file' );
			}

			// Parse the file
			this.type = data.substr( 8, 4 );

			var i = 12, l = data.length, chunk_length;
			while ( i < l )
			{
				chunk_length = string_to_Uint32( data, i + 4 );

				if ( chunk_length < 0 || ( chunk_length + i ) > l )
				{
					throw new Error( 'IFF chunk out of range' );
				}

				this.chunks.push({
					type: data.substr( i, 4 ),
					offset: i,
					data: data.substr( i + 8, chunk_length ),
				});

				i += 8 + chunk_length;
				if ( chunk_length % 2 )
				{
					i++;
				}
			}
		}
	},

	write: function()
	{
		// Start with the IFF type
		var out = this.type,
		i = 0, l = this.chunks.length,
		chunk, data;

		// Go through the chunks and write them out
		while ( i < l )
		{
			chunk = this.chunks[i++];
			data = chunk.data;
			out += chunk.type + Uint32_to_string( data.length ) + data;
			if ( data.length % 2 )
			{
				out += '\0';
			}
		}

		// Add the header and return
		return 'FORM' + Uint32_to_string( out.length ) + out;
	},
}),

Quetzal = IFF.subClass({
	// Parse a Quetzal savefile, or make a blank one
	init: function( data )
	{
		this.super.init.call( data );
		if ( data )
		{
			// Check this is a Quetzal savefile
			if ( this.type !== 'IFZS' )
			{
				throw new Error( 'Not a Quetzal savefile' );
			}

			// Go through the chunks and extract the useful ones
			var i = 0, l = this.chunks.length, type, chunk_data;
			while ( i < l )
			{
				type = this.chunks[i].type;
				chunk_data = this.chunks[i++].data;

				// Memory and stack chunks. Overwrites existing data if more than one of each is present!
				if ( type === 'CMem' || type === 'UMem' )
				{
					this.memory = data;
					this.compressed = ( type === 'CMem' );
				}
				else if ( type === 'Stks' )
				{
					this.stacks = data;
				}

				// Story file data
				else if ( type === 'IFhd' )
				{
					this.release = chunk_data.slice( 0, 2 );
					this.serial = chunk_data.slice( 2, 8 );
					// The checksum isn't used, but if we throw it away we can't round-trip
					this.checksum = chunk_data.slice( 8, 10 );
					this.pc = chunk_data[10] << 16 | chunk_data[11] << 8 | chunk_data[12];
				}
			}
		}
	},

	// Write out a savefile
	write: function()
	{
		// Reset the IFF type
		this.type = 'IFZS';

		// Format the IFhd chunk correctly
		var pc = this.pc,
		ifhd = this.release.concat(
			this.serial,
			this.checksum,
			( pc >> 16 ) & 0xFF, ( pc >> 8 ) & 0xFF, pc & 0xFF
		);

		// Add the chunks
		this.chunks = [
			{ type: 'IFhd', data: ifhd },
			{ type: ( this.compressed ? 'CMem' : 'UMem' ), data: this.memory },
			{ type: 'Stks', data: this.stacks },
		];

		// Return the byte array
		return this.super.write.call( this );
	},
});

module.exports = {
	IFF: IFF,
	Quetzal: Quetzal,
};

},{"./utils.js":3}],3:[function(require,module,exports){
/*

Common untility functions
=================================================

Copyright (c) 2013 The ifvms.js team
BSD licenced
http://github.com/curiousdannii/ifvms.js

*/

// Utility to extend objects
function extend()
{
	var old = arguments[0], i = 1, add, name;
	while ( i < arguments.length )
	{
		add = arguments[i++];
		for ( name in add )
		{
			old[name] = add[name];
		}
	}
	return old;
}

// Simple classes
// Inspired by John Resig's class implementation
// http://ejohn.org/blog/simple-javascript-inheritance/

function Class()
{}

Class.subClass = function( props )
{
	function newClass()
	{
		if ( this.init )
		{
			this.init.apply( this, arguments );
		}
	}
	newClass.prototype = extend( Object.create( this.prototype ), props );
	newClass.subClass = this.subClass;
	newClass.super = newClass.prototype.super = this.prototype;
	return newClass;
};

// An enhanced DataView
function MemoryView( buffer )
{
	return extend( new DataView( buffer ), {
		getBuffer8: function( start, length )
		{
			return new Uint8Array( this.buffer.slice( start, start + length ) );
		},
		getBuffer16: function( start, length )
		{
			return new Uint16Array( this.buffer.slice( start, start + length * 2 ) );
		},
		setBuffer8: function( start, data )
		{
			( new Uint8Array( this.buffer ) ).set( data, start );
		},
		//setBuffer16
	} );
}

// DataView doesn't seem to be subclassable in ES5: http://stackoverflow.com/a/36068693/2854284
/*function MemoryView()
{
	DataView.apply( this, arguments );
}
MemoryView.prototype = extend( Object.create( DataView.prototype ), {
	getBuffer8: function( start, length )
	{
		return new Uint8Array( this.buffer.slice( start, start + length ) );
	},
	getBuffer16: function( start, length )
	{
		return new Uint16Array( this.buffer.slice( start, start + length * 2 ) );
	},
	setBuffer8: function( start, buffer )
	{
		( new Uint8Array( this.buffer ) ).set( buffer, start );
	},
	//setBuffer16
} );*/

// Utilities for 16-bit signed arithmetic
function U2S16( value )
{
	return value << 16 >> 16;
}
function S2U16 ( value )
{
	return value & 0xFFFF;
}

// Utility to convert from byte arrays to word arrays
function byte_to_word( array )
{
	var i = 0, l = array.length,
	result = [];
	while ( i < l )
	{
		result[i / 2] = array[i++] << 8 | array[i++];
	}
	return result;
}

module.exports = {
	extend: extend,
	Class: Class,
	MemoryView: MemoryView,
	U2S16: U2S16,
	S2U16: S2U16,
	byte_to_word: byte_to_word,
};

/*// Perform some micro optimisations
function optimise( code )
{
	return code

	// Sign conversions
	.replace( /(e\.)?U2S\(([^(]+?)\)/g, '(($2)<<16>>16)' )
	.replace( /(e\.)?S2U\(([^(]+?)\)/g, '(($2)&65535)' )

	// Bytearray
	.replace( /([\w.]+)\.getUint8\(([^(]+?)\)/g, '$1[$2]' )
	.replace( /([\w.]+)\.getUint16\(([^(]+?)\)/g, '($1[$2]<<8|$1[$2+1])' );
}
// Optimise some functions of an obj, compiling several at once
function optimise_obj( obj, funcnames )
{
	var funcname, funcparts, newfuncs = [];
	for ( funcname in obj )
	{
		if ( funcnames.indexOf( funcname ) >= 0 )
		{
			funcparts = /function\s*\(([^(]*)\)\s*\{([\s\S]+)\}/.exec( '' + obj[funcname] );
			if ( DEBUG )
			{
				newfuncs.push( funcname + ':function ' + funcname + '(' + funcparts[1] + '){' + optimise( funcparts[2] ) + '}' );
			}
			else
			{
				newfuncs.push( funcname + ':function(' + funcparts[1] + '){' + optimise( funcparts[2] ) + '}' );
			}
		}
	}
	extend( obj, eval( '({' + newfuncs.join() + '})' ) );
}*/

/*if ( DEBUG ) {

	// Debug flags
	var debugflags = {},
	get_debug_flags = function( data )
	{
		data = data.split( ',' );
		var i = 0;
		while ( i < data.length )
		{
			debugflags[data[i++]] = 1;
		}
	};
	if ( typeof parchment !== 'undefined' && parchment.options && parchment.options.debug )
	{
		get_debug_flags( parchment.options.debug );
	}

} // ENDDEBUG
*/

},{}],4:[function(require,module,exports){
/*

ZVM - the ifvms.js Z-Machine (versions 3, 5 and 8)
===============================================

Copyright (c) 2016 The ifvms.js team
BSD licenced
http://github.com/curiousdannii/ifvms.js

*/

/*

This file is the public API of ZVM, which is based on the API of Quixe:
https://github.com/erkyrath/quixe/wiki/Quixe-Without-GlkOte#quixes-api

ZVM willfully ignores the standard in these ways:
	Non-buffered output is not supported
	Output streams 2 and 4 and input stream 1 are not supported
	Saving tables is not supported (yet?)
	No interpreter number or version is set

Any other non-standard behaviour should be considered a bug

*/

var utils = require( './common/utils.js' ),
Class = utils.Class,
extend = utils.extend,

api = {

	init: function()
	{
		// Create this here so that it won't be cleared on restart
		this.jit = {};
		this.env = {
			width: 80, // Default width of 80 characters
		};
		
		// The Quixe API expects the start function to be named init
		this.init = this.start;
	},

	prepare: function( storydata, options )
	{
		// If we are not given a glk option then we cannot continue
		if ( !options.glk )
		{
			throw new Error( 'a reference to Glk is required' );
		}
		this.glk = options.glk;
		
		// Convert the storyfile we are given to a Uint8Array
		this.data = new Uint8Array( storydata );
		
		// TODO: check that we are given a valid storyfile
	},

	start: function()
	{
		try {
			this.restart();
			this.run();
		}
		catch ( e )
		{
			this.glk.fatal_error("ZVM start: " + e );
			throw e;
		}
	},

	resume: function()
	{
		try {
			this.run();
		}
		catch ( e )
		{
			this.glk.fatal_error("ZVM: " + e );
			throw e;
		}
	},

	// An input event, or some other event from the runner
	inputEvent: function( data )
	{
		var memory = this.m,
		code = data.code;

		// Update environment variables
		if ( data.env )
		{
			extend( this.env, data.env );

			/*if ( this.env.debug )
			{
				if ( data.env.debug )
				{
					get_debug_flags( data.env.debug );
				}
			}*/

			// Also need to update the header

			// Stop if there's no code - we're being sent live updates
			if ( !code )
			{
				return;
			}
		}

		// Load the story file
		if ( code === 'load' )
		{
			// Convert the data we are given to a Uint8Array
			this.data = new Uint8Array( data.data );
			return;
		}

		// Clear the list of orders
		this.orders = [];

		if ( code === 'restart' )
		{
			this.restart();
		}

		if ( code === 'save' )
		{
			// Set the result variable, assume success
			this.save_restore_result( data.result || 1 );
		}

		if ( code === 'restore' )
		{
			// Restart the VM if we never have before
			if ( !this.m )
			{
				this.restart();
			}

			// Successful restore
			if ( data.data )
			{
				this.restore_file( data.data );
			}
			// Failed restore
			else
			{
				this.save_restore_result( 0 );
			}
		}

		// Handle line input
		if ( code === 'read' )
		{
			this.handle_input( data );
		}

		// Handle character input
		if ( code === 'char' )
		{
			this.variable( this.read_data.storer, this.keyinput( data.response ) );
		}

		// Write the status window's cursor position
		if ( code === 'get_cursor' )
		{
			memory.setUint16( data.addr, data.pos[0] + 1 );
			memory.setUint16( data.addr + 2, data.pos[1] + 1 );
		}

		// Resume normal operation
		this.run();
	},

	// Run
	run: function()
	{
		var pc,
		result;

		// Stop when ordered to
		this.stop = 0;
		while ( !this.stop )
		{
			pc = this.pc;
			if ( !this.jit[pc] )
			{
				this.compile();
			}
			result = this.jit[pc]( this );

			// Return from a VM func if the JIT function returned a result
			if ( !isNaN( result ) )
			{
				this.ret( result );
			}
		}
		this.glk.update();
	},

	// Compile a JIT routine
	compile: function()
	{
		var context = this.disassemble(), code, func;

		// Compile the routine with new Function()
		if ( this.env.debug )
		{
			code = '' + context;
			/*if ( !debugflags.nooptimise )
			{
				code = optimise( code );
			}
			if ( debugflags.jit )
			{
				console.log( code );
			}*/
			// We use eval because Firebug can't profile new Function
			// The 0, is to make IE8 work. h/t Secrets of the Javascript Ninja
			func = eval( '(0,function JIT_' + context.pc + '(e){' + code + '})' );

			// Extra stuff for debugging
			func.context = context;
			func.code = code;
			if ( context.name )
			{
				func.name = context.name;
			}
			this.jit[context.pc] = func;
		}
		else // DEBUG
		{
			// TODO: optimise
			//this.jit[context.pc] = new Function( 'e', optimise( '' + context ) );
			this.jit[context.pc] = new Function( 'e', '' + context );
		}
		if ( context.pc < this.staticmem )
		{
			this.warn( 'Caching a JIT function in dynamic memory: ' + context.pc );
		}
	},

	// Return control to the ZVM runner to perform some action
	act: function( code, options )
	{
		options = options || {};

		// Handle numerical codes from jit-code - these codes are opcode numbers
		if ( code === 183 )
		{
			code = 'restart';
		}
		if ( code === 186 )
		{
			code = 'quit';
		}

		options.code = code;
		this.orders.push( options );
		this.stop = 1;
		if ( this.outputEvent )
		{
			this.outputEvent( this.orders );
		}
	},

},

VM = Class.subClass( extend(
	api,
	require( './zvm/runtime.js' ),
	require( './zvm/text.js' ),
	require( './zvm/io.js' ),
	require( './zvm/disassembler.js' )
) );

module.exports = VM;

},{"./common/utils.js":3,"./zvm/disassembler.js":5,"./zvm/io.js":6,"./zvm/runtime.js":8,"./zvm/text.js":9}],5:[function(require,module,exports){
/*

Z-Machine disassembler - disassembles zcode into an AST
=======================================================

Copyright (c) 2011 The ifvms.js team
BSD licenced
http://github.com/curiousdannii/ifvms.js

*/

/*

Note:
	Nothing is done to check whether an instruction actually has a valid number of operands. Extras will usually be ignored while missing operands may throw errors at either the code building stage or when the JIT code is called.

TODO:
	If we diassessemble part of what we already have before, can we just copy/slice the context?

*/

var AST = require( '../common/ast.js' );

module.exports.disassemble = function()
{
	var pc, offset, // Set in the loop below
	memory = this.m,
	opcodes = this.opcodes,
	temp,
	code,
	opcode_class,
	operands_type, // The types of the operands, or -1 for var instructions
	operands,

	// Create the context for this code fragment
	context = new AST.RoutineContext( this, this.pc );

	// Utility function to unpack the variable form operand types byte
	function get_var_operand_types( operands_byte, operands_type )
	{
		for ( var i = 0; i < 4; i++ )
		{
			operands_type.push( (operands_byte & 0xC0) >> 6 );
			operands_byte <<= 2;
		}
	}

	// Set the context's root context to be itself, and add it to the list of subcontexts
	//context.root = context;
	//context.contexts[0] = context;

	// Run through until we can no more
	while ( 1 )
	{
		// This instruction
		offset = pc = this.pc;
		code = memory.getUint8( pc++ );

		// Extended instructions
		if ( code === 190 )
		{
			operands_type = -1;
			code = memory.getUint8( pc++ ) + 1000;
		}

		else if ( code & 0x80 )
		{
			// Variable form instructions
			if ( code & 0x40 )
			{
				operands_type = -1;
				// 2OP instruction with VAR parameters
				if ( !(code & 0x20) )
				{
					code &= 0x1F;
				}
			}

			// Short form instructions
			else
			{
				operands_type = [ (code & 0x30) >> 4 ];
				// Clear the operand type if 1OP, keep for 0OPs
				if ( operands_type[0] < 3 )
				{
					code &= 0xCF;
				}
			}
		}

		// Long form instructions
		else
		{
			operands_type = [ code & 0x40 ? 2 : 1, code & 0x20 ? 2 : 1 ];
			code &= 0x1F;
		}

		// Check for missing opcodes
		if ( !opcodes[code] )
		{
			this.log( '' + context );
			this.stop = 1;
			throw new Error( 'Unknown opcode #' + code + ' at pc=' + offset );
		}

		// Variable for quicker access to the opcode flags
		opcode_class = opcodes[code].prototype;

		// Variable form operand types
		if ( operands_type === -1 )
		{
			operands_type = [];
			get_var_operand_types( memory.getUint8(pc++), operands_type );

			// VAR_LONG opcodes have two operand type bytes
			if ( code === 236 || code === 250 )
			{
				get_var_operand_types( memory.getUint8(pc++), operands_type );
			}
		}

		// Load the operands
		operands = [];
		temp = 0;
		while ( temp < operands_type.length )
		{
			// Large constant
			if ( operands_type[temp] === 0 )
			{
				operands.push( new AST.Operand( this, memory.getUint16(pc) ) );
				pc += 2;
			}

			// Small constant
			if ( operands_type[temp] === 1 )
			{
				operands.push( new AST.Operand( this, memory.getUint8(pc++) ) );
			}

			// Variable operand
			if ( operands_type[temp++] === 2 )
			{
				operands.push( new AST.Variable( this, memory.getUint8(pc++) ) );
			}
		}

		// Check for a store variable
		if ( opcode_class.storer )
		{
			operands.push( new AST.Variable( this, memory.getUint8(pc++) ) );
		}

		// Check for a branch address
		// If we don't calculate the offset now we won't be able to tell the difference between 0x40 and 0x0040
		if ( opcode_class.brancher )
		{
			temp = memory.getUint8( pc++ );
			operands.push( [
				temp & 0x80, // iftrue
				temp & 0x40 ?
					// single byte address
					temp & 0x3F :
					// word address, but first get the second byte of it
					( temp << 8 | memory.getUint8( pc++ ) ) << 18 >> 18,
			] );
		}

		// Check for a text literal
		if ( opcode_class.printer )
		{
			// Just use the address as an operand, the text will be decoded at run time
			operands.push( pc );

			// Continue until we reach the stop bit
			// (or the end of the file, which will stop memory access errors, even though it must be a malformed storyfile)
			while ( pc < this.eof )
			{
				temp = memory.getUint8( pc );
				pc += 2;

				// Stop bit
				if ( temp & 0x80 )
				{
					break;
				}
			}
		}

		// Update the engine's pc
		this.pc = pc;

		// Create the instruction
		context.ops.push( new opcodes[code]( this, context, code, offset, pc, operands ) );

		// Check for the end of a large if block
		temp = 0;
		/*if ( context.targets.indexOf( pc ) >= 0 )
		{
			if ( DEBUG )
			{
				// Skip if we must
				if ( !debugflags.noidioms )
				{
					temp = idiom_if_block( context, pc );
				}
			}
			else
			{
				temp = idiom_if_block( context, pc );
			}
		}*/

		// We can't go any further if we have a final stopper :(
		if ( opcode_class.stopper && !temp )
		{
			break;
		}
	}

	return context;
};

},{"../common/ast.js":1}],6:[function(require,module,exports){
/*

Z-Machine IO
============

Copyright (c) 2016 The ifvms.js team
BSD licenced
http://github.com/curiousdannii/ifvms.js

*/

module.exports = {

	init_ui: function()
	{
		this.ui = {
			reverse: 0,
			bold: 0,
			italic: 0,
			fg: undefined,
			bg: undefined,
			
			// Version 3 time header bit
			time: this.m.getUint8( 0x01 ) & 0x02,
			
			// A variable for whether we are outputing in a monospaced font. If non-zero then we are
			// Bit 0 is for @set_style, bit 1 for the header, and bit 2 for @set_font
			mono: this.m.getUint8( 0x11 ) & 0x02,
		};

		this.process_colours();

		// Construct the windows if they do not already exist
		var Glk = this.glk;
		if ( !this.mainwin )
		{
			this.mainwin = Glk.glk_window_open( 0, 0, 0, 3, 201 );
			this.statuswin = Glk.glk_window_open( this.mainwin, 0x12, 0, 4, 202 );
		}
		this.set_window( 0 );
	},

	erase_line: function( value )
	{
		/*if ( value === 1 )
		{
			this.status.push( { code: 'eraseline' } );
		}*/
	},

	erase_window: function( window )
	{
		var Glk = this.glk;
		
		if ( window < 1 )
		{
			Glk.glk_window_clear( this.mainwin );
		}
		if ( window === 1 || window === -2 )
		{
			Glk.glk_window_clear( this.statuswin );
		}
		if ( window === -1 )
		{
			this.split_window( 0 );
		}
	},

	format: function()
	{
		/*var props = {},
		temp,
		classes = [],
		fg = this.fg,
		bg = this.bg;

		if ( this.bold )
		{
			classes.push( 'zvm-bold' );
		}
		if ( this.italic )
		{
			classes.push( 'zvm-italic' );
		}
		if ( this.mono )
		{
			classes.push( 'zvm-mono' );
		}
		if ( this.reverse )
		{
			temp = fg;
			fg = bg || this.env.bg;
			bg = temp || this.env.fg;
		}
		if ( typeof fg !== 'undefined' )
		{
			if ( isNaN( fg ) )
			{
				props.css = { color: fg };
			}
			else
			{
				classes.push( 'zvm-fg-' + fg );
			}
		}
		if ( typeof bg !== 'undefined' )
		{
			if ( isNaN( bg ) )
			{
				if ( !props.css )
				{
					props.css = {};
				}
				props.css['background-color'] = bg;
			}
			else
			{
				classes.push( 'zvm-bg-' + bg );
			}
		}
		if ( classes.length )
		{
			props['class'] = classes.join( ' ' );
		}
		return props;*/
	},

	get_cursor: function( array )
	{
		/*this.status.push({
			code: 'get_cursor',
			addr: array,
		});
		this.e.act();*/
	},

	// Print text!
	_print: function( text )
	{
		// Stream 3 gets the text first
		if ( this.streams[2].length )
		{
			this.streams[2][0][1] += text;
		}
		// Don't print if stream 1 was switched off (why would you do that?!)
		else if ( this.streams[0] )
		{
			// Convert CR into LF
			text = text.replace( /\r/g, '\n' );
			
			// Check if the monospace font bit has changed
			// Unfortunately, even now Inform changes this bit for the font statement, even though the 1.1 standard depreciated it :(
			if ( ( this.m.getUint8( 0x11 ) & 0x02 ) !== ( this.ui.mono & 0x02 ) )
			{
				this.ui.mono ^= 0x02;
				// TODO: send font
			}
			this.glk.glk_put_jstring( text );
		}
	},

	// Print many things
	print: function( type, val )
	{
		var proptable, result;
		
		// Number
		if ( type === 0 )
		{
			result = val;
		}
		// Unicode
		if ( type === 1 )
		{
			result = String.fromCharCode( val );
		}
		// Text from address
		if ( type === 2 )
		{
			result = this.jit[ val ] || this.decode( val );
		}
		// Object
		if ( type === 3 )
		{
			proptable = this.m.getUint16( this.objects + ( this.version3 ? 9 : 14 ) * val + ( this.version3 ? 7 : 12 ) );
			result = this.decode( proptable + 1, this.m.getUint8( proptable ) * 2 );
		}
		// ZSCII
		if ( type === 4 )
		{
			if ( !this.unicode_table[ val ] )
			{
				return;
			}
			result = this.unicode_table[ val ];
		}
		this._print( '' + result );
	},

	print_table: function( zscii, width, height, skip )
	{
		height = height || 1;
		skip = skip || 0;
		var i = 0;
		while ( i++ < height )
		{
			this._print( this.zscii_to_text( this.m.getBuffer8( zscii, width ) ) + ( i < height ? '\r' : '' ) );
			zscii += width + skip;
		}
	},

	// Process CSS default colours
	process_colours: function()
	{
		// Convert RGB to a Z-Machine true colour
		// RGB is a css colour code. rgb(), #000000 and #000 formats are supported.
		function convert_RGB( code )
		{
			var round = Math.round,
			data = /(\d+),\s*(\d+),\s*(\d+)|#(\w{1,2})(\w{1,2})(\w{1,2})/.exec( code ),
			result;

			// Nice rgb() code
			if ( data[1] )
			{
				result =  [ data[1], data[2], data[3] ];
			}
			else
			{
				// Messy CSS colour code
				result = [ parseInt( data[4], 16 ), parseInt( data[5], 16 ), parseInt( data[6], 16 ) ];
				// Stretch out compact #000 codes to their full size
				if ( code.length === 4 )
				{
					result = [ result[0] << 4 | result[0], result[1] << 4 | result[1], result[2] << 4 | result[2] ];
				}
			}

			// Convert to a 15bit colour
			return round( result[2] / 8.226 ) << 10 | round( result[1] / 8.226 ) << 5 | round( result[0] / 8.226 );
		}

		// Standard colours
		/*var colours = [
			0xFFFE, // Current
			0xFFFF, // Default
			0x0000, // Black
			0x001D, // Red
			0x0340, // Green
			0x03BD, // Yellow
			0x59A0, // Blue
			0x7C1F, // Magenta
			0x77A0, // Cyan
			0x7FFF, // White
			0x5AD6, // Light grey
			0x4631, // Medium grey
			0x2D6B,  // Dark grey
		],

		// Start with CSS colours provided by the runner
		fg_css = this.e.env.fgcolour,
		bg_css = this.e.env.bgcolour,
		// Convert to true colour for storing in the header
		fg_true = fg_css ? convert_RGB( fg_css ) : 0xFFFF,
		bg_true = bg_css ? convert_RGB( bg_css ) : 0xFFFF,
		// Search the list of standard colours
		fg = colours.indexOf( fg_true ),
		bg = colours.indexOf( bg_true );
		// ZVMUI must have colours for reversing text, even if we don't write them to the header
		// So use the given colours or assume black on white
		if ( fg < 2 )
		{
			fg = fg_css || 2;
		}
		if ( bg < 2 )
		{
			bg = bg_css || 9;
		}

		this.env = {
			fg: fg,
			bg: bg,
			fg_true: fg_true,
			bg_true: bg_true,
		};*/
	},

	// Request line input
	read: function( storer, text, parse, time, routine )
	{
		var len = this.m.getUint8( text ),
		initiallen = 0;

		if ( this.version3 )
		{
			len--;
			this.v3_status();
		}
		else
		{
			//initiallen = this.m.getUint8( text + 1 );
		}

		this.read_data = {
			buffer: text, // text-buffer
			len: len,
			parse: parse, // parse-buffer
			routine: routine,
			storer: storer,
			time: time,
		};
		
		// TODO: pre-existing input
		this.glk.glk_request_line_event_uni( this.mainwin, [], /*len,*/ initiallen );
	},

	// Request character input
	read_char: function( storer, one, time, routine )
	{
		this.read_data = {
			routine: routine,
			storer: storer,
			time: time,
		};
		this.glk.glk_request_char_event_uni( this.mainwin );
	},

	set_colour: function( foreground, background )
	{
		/*if ( foreground === 1 )
		{
			this.fg = undefined;
		}
		if ( foreground > 1 && foreground < 13 )
		{
			this.fg = foreground;
		}
		if ( background === 1 )
		{
			this.bg = undefined;
		}
		if ( background > 1 && background < 13 )
		{
			this.bg = background;
		}*/
	},

	set_cursor: function( row, col )
	{
		// TODO: cursor variables
		this.glk.glk_window_move_cursor( this.statuswin, col - 1, row - 1 );
	},

	set_font: function( font )
	{
		// We only support fonts 1 and 4
		/*if ( font !== 1 && font !== 4 )
		{
			return 0;
		}
		var returnval = this.mono & 0x04 ? 4 : 1;
		if ( font !== returnval )
		{
			this.mono ^= 0x04;
		}
		return returnval;*/
	},

	// Set styles
	set_style: function( stylebyte )
	{
		/*
		// Setting the style to Roman will clear the others
		if ( stylebyte === 0 )
		{
			this.reverse = this.bold = this.italic = 0;
			this.mono &= 0xFE;
		}
		if ( stylebyte & 0x01 )
		{
			this.reverse = 1;
		}
		if ( stylebyte & 0x02 )
		{
			this.bold = 1;
		}
		if ( stylebyte & 0x04 )
		{
			this.italic = 1;
		}
		if ( stylebyte & 0x08 )
		{
			this.mono |= 0x01;
		}*/
	},

	// Set true colours
	set_true_colour: function( foreground, background )
	{
		// Convert a 15 bit colour to RGB
		/*function convert_true_colour( colour )
		{
			// Stretch the five bits per colour out to 8 bits
			var newcolour = Math.round( ( colour & 0x1F ) * 8.226 ) << 16
				| Math.round( ( ( colour & 0x03E0 ) >> 5 ) * 8.226 ) << 8
				| Math.round( ( ( colour & 0x7C00 ) >> 10 ) * 8.226 );
			newcolour = newcolour.toString( 16 );
			// Ensure the colour is 6 bytes long
			while ( newcolour.length < 6 )
			{
				newcolour = '0' + newcolour;
			}
			return '#' + newcolour;
		}

		if ( foreground === 0xFFFF )
		{
			this.fg = undefined;
		}
		else if ( foreground < 0x8000 )
		{
			this.fg = convert_true_colour( foreground );
		}

		if ( background === 0xFFFF )
		{
			this.bg = undefined;
		}
		else if ( background < 0x8000 )
		{
			this.bg = convert_true_colour( background );
		}*/
	},

	set_window: function( window )
	{
		var Glk = this.glk;
		
		Glk.glk_set_window( window ? this.statuswin : this.mainwin );
		
		// Focusing the upper window resets the cursor to the top left
		if ( window )
		{
			// TODO: cursor variables
			Glk.glk_window_move_cursor( this.statuswin, 0, 0 );
		}
	},

	split_window: function( lines )
	{
		var Glk = this.glk;
		
		Glk.glk_window_set_arrangement( Glk.glk_window_get_parent( this.statuswin ), 0x12, lines, null );
		
		// 8.6.1.1.2: In version three the upper window is always cleared
		if ( this.version3 )
		{
			Glk.glk_window_clear( this.statuswin );
		}
	},

	// Update ZVM's header with correct colour information
	// If colours weren't provided then the default colour will be used for both
	update_header: function()
	{
		/*var memory = this.m;
		memory.setUint8( 0x2C, isNaN( this.env.bg ) ? 1 : this.env.bg );
		memory.setUint8( 0x2D, isNaN( this.env.fg ) ? 1 : this.env.fg );
		this.extension_table( 5, this.env.fg_true );
		this.extension_table( 6, this.env.bg_true );*/
	},

	// Output the version 3 status line
	v3_status: function()
	{
		/*var engine = this.e,
		width = engine.env.width,
		hours_score = engine.m.getUint16( engine.globals + 2 ),
		mins_turns = engine.m.getUint16( engine.globals + 4 ),
		rhs;
		this.set_window( 1 );
		this.set_style( 1 );
		engine._print( Array( width + 1 ).join( ' ' ) );
		this.set_cursor( 1, 1 );

		// Handle the turns/score or time
		if ( this.time )
		{
			rhs = 'Time: ' + ( hours_score % 12 === 0 ? 12 : hours_score % 12 ) + ':' + ( mins_turns < 10 ? '0' : '' ) + mins_turns + ' ' + ( hours_score > 11 ? 'PM' : 'AM' );
		}
		else
		{
			rhs = 'Score: ' + hours_score + '  Turns: ' + mins_turns;
		}

		engine.print( 3, engine.m.getUint16( engine.globals ) );
		// this.buffer now has the room name, so ensure it is not too long
		this.buffer = ' ' + this.buffer.slice( 0, width - rhs.length - 4 );

		this.set_cursor( 1, width - rhs.length );
		engine._print( rhs );
		this.set_style( 0 );
		this.set_window( 0 );*/
	},

};

},{}],7:[function(require,module,exports){
/*

Z-Machine opcodes
=================

Copyright (c) 2016 The ifvms.js team
BSD licenced
http://github.com/curiousdannii/ifvms.js

*/

/*

TODO:
	Abstract out the signed conversions such that they can be eliminated if possible
	don't access memory directly

*/

var AST = require( '../common/ast.js' ),
Variable = AST.Variable,
Opcode = AST.Opcode,
Stopper = AST.Stopper,
Pauser = AST.Pauser,
Brancher = AST.Brancher,
BrancherStorer = AST.BrancherStorer,
Storer = AST.Storer,
Caller = AST.Caller,
CallerStorer = AST.CallerStorer,
opcode_builder = AST.opcode_builder,

// Common functions, variables and opcodes
simple_func = function( a ) { return '' + a; },
stack_var = new Variable( this.e, 0 ),
alwaysbranch = opcode_builder( Brancher, function() { return 1; } ),
not = opcode_builder( Storer, function( a ) { return 'e.S2U(~' + a + ')'; } ),

// Indirect storer opcodes - rather non-generic I'm afraid
// Not used for inc/dec
// @load (variable) -> (result)
// @pull (variable)
// @store (variable) value
Indirect = Storer.subClass({
	storer: 0,

	post: function()
	{
		var operands = this.operands,
		op0 = operands[0],
		op0isVar = op0 instanceof Variable;

		// Replace the indirect operand with a Variable, and set .indirect if needed
		operands[0] = new Variable( this.e, op0isVar ? op0 : op0.v );
		if ( op0isVar || op0.v === 0 )
		{
			operands[0].indirect = 1;
		}

		// Get the storer
		this.storer = this.code === 142 ? operands.pop() : operands.shift();

		// @pull needs an added stack. If for some reason it was compiled with two operands this will break!
		if ( operands.length === 0 )
		{
			operands.push( stack_var );
		}
	},

	func: simple_func,
}),

Incdec = Opcode.subClass({
	func: function( variable )
	{
		var varnum = variable.v - 1,
		operator = this.code % 2 ? 1 : -1;

		// Fallback to the runtime function if our variable is a variable operand itself
		// Or, if it's a global
		if ( variable instanceof Variable || varnum > 14 )
		{
			return 'e.incdec(' + variable + ',' + operator + ')';
		}

		return ( varnum < 0 ? 'e.s[e.s.length-1]=e.S2U(e.s[e.s.length-1]+' : ( 'e.l[' + varnum + ']=e.S2U(e.l[' + varnum + ']+' ) ) + operator + ')';
	},
}),

// Version 3 @save/restore branch instead of store
V3SaveRestore = Stopper.subClass({
	brancher: 1,

	toString: function()
	{
		return 'e.' + ( this.code === 181 ? 'save' : 'restore' ) + '(' + ( this.pc + 1 ) + ')';
	},
});

/*eslint brace-style: "off" */
/*eslint indent: "off" */

module.exports = function( version3 )
{

return {

/* je */ 1: opcode_builder( Brancher, function() { return arguments.length === 2 ? this.args( '===' ) : 'e.jeq(' + this.args() + ')'; } ),
/* jl */ 2: opcode_builder( Brancher, function( a, b ) { return a.U2S() + '<' + b.U2S(); } ),
/* jg */ 3: opcode_builder( Brancher, function( a, b ) { return a.U2S() + '>' + b.U2S(); } ),
// Too many U2S/S2U for these...
/* dec_chk */ 4: opcode_builder( Brancher, function( variable, value ) { return 'e.U2S(e.incdec(' + variable + ',-1))<' + value.U2S(); } ),
/* inc_chk */ 5: opcode_builder( Brancher, function( variable, value ) { return 'e.U2S(e.incdec(' + variable + ',1))>' + value.U2S(); } ),
/* jin */ 6: opcode_builder( Brancher, function() { return 'e.jin(' + this.args() + ')'; } ),
/* test */ 7: opcode_builder( Brancher, function() { return 'e.test(' + this.args() + ')'; } ),
/* or */ 8: opcode_builder( Storer, function() { return this.args( '|' ); } ),
/* and */ 9: opcode_builder( Storer, function() { return this.args( '&' ); } ),
/* test_attr */ 10: opcode_builder( Brancher, function() { return 'e.test_attr(' + this.args() + ')'; } ),
/* set_attr */ 11: opcode_builder( Opcode, function() { return 'e.set_attr(' + this.args() + ')'; } ),
/* clear_attr */ 12: opcode_builder( Opcode, function() { return 'e.clear_attr(' + this.args() + ')'; } ),
/* store */ 13: Indirect,
/* insert_obj */ 14: opcode_builder( Opcode, function() { return 'e.insert_obj(' + this.args() + ')'; } ),
/* loadw */ 15: opcode_builder( Storer, function( array, index ) { return 'm.getUint16(e.S2U(' + array + '+2*' + index.U2S() + '))'; } ),
/* loadb */ 16: opcode_builder( Storer, function( array, index ) { return 'm.getUint8(e.S2U(' + array + '+' + index.U2S() + '))'; } ),
/* get_prop */ 17: opcode_builder( Storer, function() { return 'e.get_prop(' + this.args() + ')'; } ),
/* get_prop_addr */ 18: opcode_builder( Storer, function() { return 'e.find_prop(' + this.args() + ')'; } ),
/* get_next_prop */ 19: opcode_builder( Storer, function() { return 'e.find_prop(' + this.args( ',0,' ) + ')'; } ),
/* add */ 20: opcode_builder( Storer, function() { return 'e.S2U(' + this.args( '+' ) + ')'; } ),
/* sub */ 21: opcode_builder( Storer, function() { return 'e.S2U(' + this.args( '-' ) + ')'; } ),
/* mul */ 22: opcode_builder( Storer, function() { return 'e.S2U(' + this.args( '*' ) + ')'; } ),
/* div */ 23: opcode_builder( Storer, function( a, b ) { return 'e.S2U(parseInt(' + a.U2S() + '/' + b.U2S() + '))'; } ),
/* mod */ 24: opcode_builder( Storer, function( a, b ) { return 'e.S2U(' + a.U2S() + '%' + b.U2S() + ')'; } ),
/* call_2s */ 25: CallerStorer,
/* call_2n */ 26: Caller,
/* set_colour */ 27: opcode_builder( Opcode, function() { return 'e.set_colour(' + this.args() + ')'; } ),
/* throw */ 28: opcode_builder( Stopper, function( value, cookie ) { return 'while(e.call_stack.length>' + cookie + '){e.call_stack.shift()}return ' + value; } ),
/* jz */ 128: opcode_builder( Brancher, function( a ) { return a + '===0'; } ),
/* get_sibling */ 129: opcode_builder( BrancherStorer, function( obj ) { return 'e.get_sibling(' + obj + ')'; } ),
/* get_child */ 130: opcode_builder( BrancherStorer, function( obj ) { return 'e.get_child(' + obj + ')'; } ),
/* get_parent */ 131: opcode_builder( Storer, function( obj ) { return 'e.get_parent(' + obj + ')'; } ),
/* get_prop_length */ 132: opcode_builder( Storer, function( a ) { return 'e.get_prop_len(' + a + ')'; } ),
/* inc */ 133: Incdec,
/* dec */ 134: Incdec,
/* print_addr */ 135: opcode_builder( Opcode, function( addr ) { return 'e.print(2,' + addr + ')'; } ),
/* call_1s */ 136: CallerStorer,
/* remove_obj */ 137: opcode_builder( Opcode, function( obj ) { return 'e.remove_obj(' + obj + ')'; } ),
/* print_obj */ 138: opcode_builder( Opcode, function( obj ) { return 'e.print(3,' + obj + ')'; } ),
/* ret */ 139: opcode_builder( Stopper, function( a ) { return 'return ' + a; } ),
/* jump */ 140: opcode_builder( Stopper, function( a ) { return 'e.pc=' + a.U2S() + '+' + ( this.next - 2 ); } ),
/* print_paddr */ 141: opcode_builder( Opcode, function( addr ) { return 'e.print(2,' + addr + '*' + this.e.addr_multipler + ')'; } ),
/* load */ 142: Indirect.subClass( { storer: 1 } ),
143: version3 ?
	/* not (v3) */ not :
	/* call_1n (v5/8) */ Caller,
/* rtrue */ 176: opcode_builder( Stopper, function() { return 'return 1'; } ),
/* rfalse */ 177: opcode_builder( Stopper, function() { return 'return 0'; } ),
// Reconsider a generalised class for @print/@print_ret?
/* print */ 178: opcode_builder( Opcode, function( text ) { return 'e.print(2,' + text + ')'; }, { printer: 1 } ),
/* print_ret */ 179: opcode_builder( Stopper, function( text ) { return 'e.print(2,' + text + ');e.print(1,13);return 1'; }, { printer: 1 } ),
/* nop */ 180: Opcode,
/* save (v3) */ 181: V3SaveRestore,
/* restore (v3) */ 182: V3SaveRestore,
/* restart */ 183: opcode_builder( Stopper, function() { return 'e.act(183)'; } ),
/* ret_popped */ 184: opcode_builder( Stopper, function( a ) { return 'return ' + a; }, { post: function() { this.operands.push( stack_var ); } } ),
185: version3 ?
	/* pop (v3) */ opcode_builder( Opcode, function() { return 's.pop()'; } ) :
	/* catch (v5/8) */ opcode_builder( Storer, function() { return 'e.call_stack.length'; } ),
/* quit */ 186: opcode_builder( Stopper, function() { return 'e.act(186)'; } ),
/* new_line */ 187: opcode_builder( Opcode, function() { return 'e.print(1,13)'; } ),
188: version3 ?
	/* show_status (v3) */ opcode_builder( Stopper, function() { return 'e.pc=' + this.next + ';e.v3_status();e.act()'; } ) :
	/* act as a nop in later versions */ Opcode,
/* verify */ 189: alwaysbranch, // Actually check??
/* piracy */ 191: alwaysbranch,
/* call_vs */ 224: CallerStorer,
/* storew */ 225: opcode_builder( Opcode, function( array, index, value ) { return 'm.setUint16(e.S2U(' + array + '+2*' + index.U2S() + '),' + value + ')'; } ),
/* storeb */ 226: opcode_builder( Opcode, function( array, index, value ) { return 'm.setUint8(e.S2U(' + array + '+' + index.U2S() + '),' + value + ')'; } ),
/* put_prop */ 227: opcode_builder( Opcode, function() { return 'e.put_prop(' + this.args() + ')'; } ),
/* read */ 228: version3 ?
	opcode_builder( Stopper, function() { return 'e.pc=' + this.next + ';e.read(0,' + this.args() + ');e.stop=1'; } ) :
	opcode_builder( Pauser, function() { return 'e.read(' + this.storer.v + ',' + this.args() + ');e.stop=1'; } ),
/* print_char */ 229: opcode_builder( Opcode, function( a ) { return 'e.print(4,' + a + ')'; } ),
/* print_num */ 230: opcode_builder( Opcode, function( a ) { return 'e.print(0,' + a.U2S() + ')'; } ),
/* random */ 231: opcode_builder( Storer, function( a ) { return 'e.random(' + a.U2S() + ')'; } ),
/* push */ 232: opcode_builder( Storer, simple_func, { post: function() { this.storer = stack_var; }, storer: 0 } ),
/* pull */ 233: Indirect,
/* split_window */ 234: opcode_builder( Opcode, function( lines ) { return 'e.split_window(' + lines + ')'; } ),
/* set_window */ 235: opcode_builder( Opcode, function( wind ) { return 'e.set_window(' + wind + ')'; } ),
/* call_vs2 */ 236: CallerStorer,
/* erase_window */ 237: opcode_builder( Opcode, function( win ) { return 'e.erase_window(' + win.U2S() + ')'; } ),
/* erase_line */ 238: opcode_builder( Opcode, function( a ) { return 'e.erase_line(' + a + ')'; } ),
/* set_cursor */ 239: opcode_builder( Opcode, function() { return 'e.set_cursor(' + this.args() + ')'; } ),
/* get_cursor */ 240: opcode_builder( Pauser, function( addr ) { return 'e.get_cursor(' + addr + ')'; } ),
/* set_text_style */ 241: opcode_builder( Opcode, function( stylebyte ) { return 'e.set_style(' + stylebyte + ')'; } ),
/* buffer_mode */ 242: Opcode, // We don't support non-buffered output
/* output_stream */ 243: opcode_builder( Opcode, function() { return 'e.output_stream(' + this.args() + ')'; } ),
/* input_stream */ 244: Opcode, // We don't support changing the input stream
/* sound_effect */ 245: Opcode, // We don't support sounds
/* read_char */ 246: opcode_builder( Pauser, function() { return 'e.read_char(' + this.storer.v + ',' + ( this.args() || '1' ) + ');e.stop=1'; } ),
/* scan_table */ 247: opcode_builder( BrancherStorer, function() { return 'e.scan_table(' + this.args() + ')'; } ),
/* not (v5/8) */ 248: not,
/* call_vn */ 249: Caller,
/* call_vn2 */ 250: Caller,
/* tokenise */ 251: opcode_builder( Opcode, function() { return 'e.tokenise(' + this.args() + ')'; } ),
/* encode_text */ 252: opcode_builder( Opcode, function() { return 'e.encode_text(' + this.args() + ')'; } ),
/* copy_table */ 253: opcode_builder( Opcode, function() { return 'e.copy_table(' + this.args() + ')'; } ),
/* print_table */ 254: opcode_builder( Opcode, function() { return 'e.print_table(' + this.args() + ')'; } ),
/* check_arg_count */ 255: opcode_builder( Brancher, function( arg ) { return arg + '<=e.call_stack[0][4]'; } ),
/* save */ 1000: opcode_builder( Pauser, function() { return 'e.save(' + ( this.next - 1 ) + ')'; } ),
/* restore */ 1001: opcode_builder( Pauser, function() { return 'e.restore(' + ( this.next - 1 ) + ')'; } ),
/* log_shift */ 1002: opcode_builder( Storer, function( a, b ) { return 'e.S2U(e.log_shift(' + a + ',' + b.U2S() + '))'; } ),
/* art_shift */ 1003: opcode_builder( Storer, function( a, b ) { return 'e.S2U(e.art_shift(' + a.U2S() + ',' + b.U2S() + '))'; } ),
/* set_font */ 1004: opcode_builder( Storer, function( font ) { return 'e.set_font(' + font + ')'; } ),
/* save_undo */ 1009: opcode_builder( Storer, function() { return 'e.save_undo(' + this.next + ',' + this.storer.v + ')'; } ),
// As the standard says calling this without a save point is illegal, we don't need to actually store anything (but it must still be disassembled)
/* restore_undo */ 1010: opcode_builder( Opcode, function() { return 'if(e.restore_undo())return'; }, { storer: 1 } ),
/* print_unicode */ 1011: opcode_builder( Opcode, function( a ) { return 'e.print(1,' + a + ')'; } ),
// Assume we can print and read all unicode characters rather than actually testing
/* check_unicode */ 1012: opcode_builder( Storer, function() { return 3; } ),
/* set_true_colour */ 1013: opcode_builder( Opcode, function() { return 'e.set_true_colour(' + this.args() + ')'; } ),
/* sound_data */ 1014: Opcode.subClass( { brancher: 1 } ), // We don't support sounds (but disassemble the branch address)
/* gestalt */ 1030: opcode_builder( Storer, function() { return 'e.gestalt(' + this.args() + ')'; } ),
/* parchment */ //1031: opcode_builder( Storer, function() { return 'e.op_parchment(' + this.args() + ')'; } ),

};

};

},{"../common/ast.js":1}],8:[function(require,module,exports){
/*

Z-Machine runtime functions
===========================

Copyright (c) 2016 The ifvms.js team
BSD licenced
http://github.com/curiousdannii/ifvms.js

*/

/*

TODO:
	Check when restoring that it's a savefile for this storyfile
	Save/restore: table, name, prompt support

*/

/*eslint no-console: "off" */

var utils = require( '../common/utils.js' ),
extend = utils.extend,
U2S = utils.U2S16,
S2U = utils.S2U16,
byte_to_word = utils.byte_to_word,

file = require( '../common/file.js' );

module.exports = {

	art_shift: function( number, places )
	{
		return places > 0 ? number << places : number >> -places;
	},

	// Call a routine
	call: function( addr, storer, next, args )
	{
		// 6.4.3: Calls to 0 instead just store 0
		if ( addr === 0 )
		{
			if ( storer >= 0 )
			{
				this.variable( storer, 0 );
			}
			return this.pc = next;
		}

		var i,
		locals_count,
		old_locals_count = this.l.length,

		// Keep the number of provided args for @check_arg_count
		provided_args = args.length;

		// Get the number of locals and advance the pc
		this.pc = addr * this.addr_multipler;
		locals_count = this.m.getUint8( this.pc++ );

		// Add the locals
		// Trim args to the count if needed
		args = args.slice( 0, locals_count );
		// Add any extras
		for ( i = args.length; i < locals_count; i++ )
		{
			// Use provided arguments in version 3, or 0 in later versions
			args.push( this.version3 ? this.m.getUint16( this.pc + i * 2 ) : 0 );
		}
		if ( this.version3 )
		{
			this.pc += locals_count * 2;
		}

		// Prepend to the locals array
		this.l = args.concat( this.l );

		// Push the call stack (well unshift really)
		this.call_stack.unshift( [ next, storer, locals_count, this.s.length, provided_args, old_locals_count ] );
	},

	clear_attr: function( object, attribute )
	{
		var addr = this.objects + ( this.version3 ? 9 : 14 ) * object + ( attribute / 8 ) | 0;
		this.m.setUint8( addr, this.m.getUint8( addr ) & ~( 0x80 >> attribute % 8 ) );
	},

	copy_table: function( first, second, size )
	{
		size = U2S( size );
		var memory = this.m,
		i = 0,
		allowcorrupt = size < 0;
		size = Math.abs( size );

		// Simple case, zeroes
		if ( second === 0 )
		{
			while ( i < size )
			{
				memory.setUint8( first + i++, 0 );
			}
			return;
		}

		if ( allowcorrupt )
		{
			while ( i < size )
			{
				memory.setUint8( second + i, memory.getUint8( first + i++ ) );
			}
		}
		else
		{
			memory.setBuffer8( second, memory.getBuffer8( first, size ) );
		}
	},

	encode_text: function( zscii, length, from, target )
	{
		this.m.setBuffer8( target, this.encode( this.m.getBuffer8( zscii + from, length ) ) );
	},

	// Access the extension table
	extension_table: function( word, value )
	{
		var addr = this.extension;
		if ( !addr || word > this.extension_count )
		{
			return 0;
		}
		addr += 2 * word;
		if ( value === undefined )
		{
			return this.m.getUint16( addr );
		}
		this.e.setUint16( addr, value );
	},

	// Find the address of a property, or given the previous property, the number of the next
	find_prop: function( object, property, prev )
	{
		var memory = this.m,
		version3 = this.version3,

		this_property_byte, this_property,
		last_property = 0,

		// Get this property table
		properties = memory.getUint16( this.objects + ( version3 ? 9 : 14 ) * object + ( version3 ? 7 : 12 ) );

		// Skip over the object's short name
		properties += memory.getUint8( properties ) * 2 + 1;

		// Run through the properties
		while ( 1 )
		{
			this_property_byte = memory.getUint8( properties );
			this_property = this_property_byte & ( version3 ? 0x1F : 0x3F );

			// Found the previous property, so return this one's number
			if ( last_property === prev )
			{
				return this_property;
			}
			// Found the property! Return its address
			if ( this_property === property )
			{
				// Must include the offset
				return properties + ( !version3 && this_property_byte & 0x80 ? 2 : 1 );
			}
			// Gone past the property
			if ( this_property < property )
			{
				return 0;
			}

			// Go to next property
			last_property = this_property;

			// Calculate the size of this property and skip to the next
			if ( version3 )
			{
				properties += ( this_property_byte >> 5 ) + 2;
			}
			else
			{
				if ( this_property_byte & 0x80 )
				{
					this_property = memory.getUint8( properties + 1 ) & 0x3F;
					properties += this_property ? this_property + 2 : 66;
				}
				else
				{
					properties += this_property_byte & 0x40 ? 3 : 2;
				}
			}
		}
	},

	// 1.2 spec @gestalt
	gestalt: function( id /*, arg*/ )
	{
		switch ( id )
		{
			case 1:
				return 0x0102;
			case 0x2000:
				return 1;
			// These aren't really applicable, but 2 is closer than 1
			case 0x2001:
			case 0x2002:
				return 2;
		}
		return 0;
	},

	// Get the first child of an object
	get_child: function( obj )
	{
		if ( this.version3 )
		{
			return this.m.getUint8( this.objects + 9 * obj + 6 );
		}
		else
		{
			return this.m.getUint16( this.objects + 14 * obj + 10 );
		}
	},

	get_sibling: function( obj )
	{
		if ( this.version3 )
		{
			return this.m.getUint8( this.objects + 9 * obj + 5 );
		}
		else
		{
			return this.m.getUint16( this.objects + 14 * obj + 8 );
		}
	},

	get_parent: function( obj )
	{
		if ( this.version3 )
		{
			return this.m.getUint8( this.objects + 9 * obj + 4 );
		}
		else
		{
			return this.m.getUint16( this.objects + 14 * obj + 6 );
		}
	},

	get_prop: function( object, property )
	{
		var memory = this.m,

		// Try to find the property
		addr = this.find_prop( object, property ),
		len;

		// If we have the property
		if ( addr )
		{
			len = memory.getUint8( addr - 1 );
			// Assume we're being called for a valid short property
			return memory[ ( this.version3 ? len >> 5 : len & 0x40 ) ? 'getUint16' : 'getUint8' ]( addr );
		}

		// Use the default properties table
		// Remember that properties are 1-indexed
		return memory.getUint16( this.properties + 2 * ( property - 1 ) );
	},

	// Get the length of a property
	// This opcode expects the address of the property data, not a property block
	get_prop_len: function( addr )
	{
		// Spec 1.1
		if ( addr === 0 )
		{
			return 0;
		}

		var value = this.m.getUint8( addr - 1 );

		// Version 3
		if ( this.version3 )
		{
			return ( value >> 5 ) + 1;
		}

		// Two size/number bytes
		if ( value & 0x80 )
		{
			value &= 0x3F;
			return value === 0 ? 64 : value;
		}
		// One byte size/number
		return value & 0x40 ? 2 : 1;
	},

	// Handle line input
	handle_input: function( data )
	{
		var memory = this.m,
		options = this.read_data,

		// Echo the response (7.1.1.1)
		response = data.response;
		this._print( response + '\r' );

		// Convert the response to lower case and then to ZSCII
		response = this.text_to_zscii( response.toLowerCase() );

		// Check if the response is too long, and then set its length
		if ( response.length > options.len )
		{
			response = response.slice( 0, options.len );
		}

		if ( this.version3 )
		{
			// Append zero terminator
			response.push( 0 );

			// Store the response in the buffer
			memory.setBuffer8( options.buffer + 1, response );
		}
		else
		{
			// Store the response length
			memory.setUint8( options.buffer + 1, response.length );

			// Store the response in the buffer
			memory.setBuffer8( options.buffer + 2, response );

			// Store the terminator
			this.variable( options.storer, isNaN( data.terminator ) ? 13 : data.terminator );
		}

		if ( options.parse )
		{
			// Tokenise the response
			this.tokenise( options.buffer, options.parse );
		}
	},

	// Quick hack for @inc/@dec/@inc_chk/@dec_chk
	incdec: function( varnum, change )
	{
		var result, offset;
		if ( varnum === 0 )
		{
			result = S2U( this.s.pop() + change );
			this.s.push( result );
			return result;
		}
		if ( --varnum < 15 )
		{
			return this.l[varnum] = S2U( this.l[varnum] + change );
		}
		else
		{
			offset = this.globals + ( varnum - 15 ) * 2;
			result = this.m.getUint16( offset ) + change;
			this.m.setUint16( offset, result );
			return result;
		}
	},

	// Indirect variables
	indirect: function( variable, value )
	{
		if ( variable === 0 )
		{
			if ( arguments.length > 1 )
			{
				return this.s[this.s.length - 1] = value;
			}
			else
			{
				return this.s[this.s.length - 1];
			}
		}
		return this.variable( variable, value );
	},

	insert_obj: function( obj, dest )
	{
		// First remove the obj from wherever it was
		this.remove_obj( obj );
		// Now add it to the destination
		this.set_family( obj, dest, dest, obj, obj, this.get_child( dest ) );
	},

	// @jeq
	jeq: function()
	{
		var i = 1;

		// Account for many arguments
		while ( i < arguments.length )
		{
			if ( arguments[i++] === arguments[0] )
			{
				return 1;
			}
		}
	},

	jin: function( child, parent )
	{
		return this.get_parent( child ) === parent;
	},

	log: function()
	{
		if ( this.env.debug && typeof console !== 'undefined' && console.log )
		{
			console.log.apply( console, arguments );
		}
	},

	log_shift: function( number, places )
	{
		return places > 0 ? number << places : number >>> -places;
	},

	// Manage output streams
	output_stream: function( stream, addr )
	{
		stream = U2S( stream );
		if ( stream === 1 )
		{
			this.streams[0] = 1;
		}
		if ( stream === -1 )
		{
			this.log( 'Disabling stream one - it actually happened!' );
			this.streams[0] = 0;
		}
		if ( stream === 3 )
		{
			this.streams[2].unshift( [ addr, '' ] );
		}
		if ( stream === -3 )
		{
			var data = this.streams[2].shift(),
			text = this.text_to_zscii( data[1] );
			this.m.setUint16( data[0], text.length );
			this.m.setBuffer8( data[0] + 2, text );
		}
	},

	put_prop: function( object, property, value )
	{
		var memory = this.m,

		// Try to find the property
		addr = this.find_prop( object, property ),
		len;

		if ( addr )
		{
			len = memory.getUint8( addr - 1 );

			// Assume we're being called for a valid short property
			memory[ ( this.version3 ? len >> 5 : len & 0x40 ) ? 'setUint16' : 'setUint8' ]( addr, value );
		}
	},

	random: function( range )
	{
		var seed = this.xorshift_seed;

		// Switch to the Xorshift RNG (or switch off if range == 0)
		if ( range < 1 )
		{
			this.xorshift_seed = range;
			return 0;
		}

		// Pure randomness
		if ( seed === 0 )
		{
			return 1 + ( Math.random() * range ) | 0;
		}

		// Based on the discussions in this forum topic, we will not implement the sequential mode recommended in the standard
		// http://www.intfiction.org/forum/viewtopic.php?f=38&t=16023

		// Instead implement a 32 bit Xorshift generator
		seed ^= ( seed << 13 );
		seed ^= ( seed >> 17 );
		this.xorshift_seed = ( seed ^= ( seed << 5 ) );
		return 1 + ( ( seed & 0x7FFF ) % range );
	},

	remove_obj: function( obj )
	{
		var parent = this.get_parent( obj ),
		older_sibling,
		younger_sibling,
		temp_younger;

		// No parent, do nothing
		if ( parent === 0 )
		{
			return;
		}

		older_sibling = this.get_child( parent );
		younger_sibling = this.get_sibling( obj );

		// obj is first child
		if ( older_sibling === obj )
		{
			this.set_family( obj, 0, parent, younger_sibling );
		}
		// obj isn't first child, so fix the older sibling
		else
		{
			// Go through the tree until we find the older sibling
			while ( 1 )
			{
				temp_younger = this.get_sibling( older_sibling );
				if ( temp_younger === obj )
				{
					break;
				}
				older_sibling = temp_younger;
			}
			this.set_family( obj, 0, 0, 0, older_sibling, younger_sibling );
		}
	},

	// (Re)start the VM
	restart: function()
	{
		// Set up the memory
		var memory = utils.MemoryView( this.data.buffer.slice() ),

		version = memory.getUint8( 0x00 ),
		version3 = version === 3,
		addr_multipler = version3 ? 2 : ( version === 5 ? 4 : 8 ),
		property_defaults = memory.getUint16( 0x0A ),
		extension = memory.getUint16( 0x36 );

		// Check if the version is supported
		if ( version !== 3 && version !== 5 && version !== 8 )
		{
			throw new Error( 'Unsupported Z-Machine version: ' + version );
		}

		// Preserve flags 2 - the fixed pitch bit is surely the lamest part of the Z-Machine spec!
		if ( this.m )
		{
			memory.setUint8( 0x11, this.m.getUint8( 0x11 ) );
		}

		extend( this, {

			// Memory, locals and stacks of various kinds
			m: memory,
			s: [],
			l: [],
			call_stack: [],
			undo: [],

			// IO stuff
			streams: [ 1, 0, [], 0 ],

			// Get some header variables
			version: version,
			version3: version === 3,
			pc: memory.getUint16( 0x06 ),
			properties: property_defaults,
			objects: property_defaults + ( version3 ? 53 : 112 ), // 62-9 or 126-14 - if we take this now then we won't need to always decrement the object number
			globals: memory.getUint16( 0x0C ),
			staticmem: memory.getUint16( 0x0E ),
			eof: ( memory.getUint16( 0x1A ) || 65536 ) * addr_multipler,
			extension: extension,
			extension_count: extension ? memory.getUint16( extension ) : 0,

			// Routine and string multiplier
			addr_multipler: addr_multipler,

			// Opcodes for this version of the Z-Machine
			opcodes: require( './opcodes.js' )( version3 ),

		});

		this.init_text();
		this.init_ui();

		// Update the header
		this.update_header();
	},

	// Request a restore
	restore: function( pc )
	{
		this.save_restore_pc = pc;
		this.act( 'restore' );
	},

	restore_file: function( data )
	{
		var memory = this.m,
		quetzal = new file.Quetzal( data ),
		qmem = quetzal.memory,
		qstacks = quetzal.stacks,
		flags2 = memory.getUint8( 0x11 ),
		temp,
		i = 0, j = 0,
		call_stack = [],
		newlocals = [],
		newstack;

		// Memory chunk
		memory.setBuffer8( 0, this.data.slice( 0, this.staticmem ) );
		if ( quetzal.compressed )
		{
			while ( i < qmem.length )
			{
				temp = qmem[i++];
				// Same memory
				if ( temp === 0 )
				{
					j += 1 + qmem[i++];
				}
				else
				{
					memory.setUint8( j, temp ^ this.data[j++] );
				}
			}
		}
		else
		{
			memory.setBuffer8( 0, qmem );
		}
		// Preserve flags 1
		memory.setUint8( 0x11, flags2 );

		// Stacks chunk
		i = 6;
		// Dummy call frame
		temp = qstacks[i++] << 8 | qstacks[i++];
		newstack = byte_to_word( qstacks.slice( i, temp ) );
		// Regular frames
		while ( i < qstacks.length )
		{
			call_stack.unshift( [
				qstacks[i++] << 16 | qstacks[i++] << 8 | qstacks[i++], // pc
				0,
				0,
				newstack.length,
				0,
				newlocals.length,
			] );
			call_stack[0][1] = qstacks[i] & 0x10 ? -1 : qstacks[i + 1]; // storer
			call_stack[0][2] = qstacks[i] & 0x0F; // local count
			i += 2;
			temp = qstacks[i++];
			while ( temp )
			{
				call_stack[0][4]++; // provided_args - this is a stupid way to store it
				temp >>= 1;
			}
			temp = ( qstacks[i++] << 8 | qstacks[i++] ) * 2; // "eval" stack length
			newlocals = byte_to_word( qstacks.slice( i, ( i += call_stack[0][2] * 2 ) ) ).concat( newlocals );
			newstack = newstack.concat( byte_to_word( qstacks.slice( i, ( i += temp ) ) ) );
		}
		this.call_stack = call_stack;
		this.l = newlocals;
		this.s = newstack;

		// Update the header
		this.update_header();

		// Store or branch with the successful result
		this.save_restore_pc = quetzal.pc;
		this.save_restore_result( 2 );

		// Collapse the upper window (8.6.1.3)
		if ( this.version3 )
		{
			this.split_window( 0 );
		}
	},

	restore_undo: function()
	{
		if ( this.undo.length === 0 )
		{
			return 0;
		}
		var state = this.undo.pop();
		this.pc = state[0];
		// Preserve flags 2
		state[2][0x11] = this.m.getUint8( 0x11 );
		this.m.setBuffer8( 0, state[2] );
		this.l = state[3];
		this.s = state[4];
		this.call_stack = state[5];
		this.variable( state[1], 2 );
		return 1;
	},

	// Return from a routine
	ret: function( result )
	{
		var call_stack = this.call_stack.shift(),
		storer = call_stack[1];

		// Correct everything again
		this.pc = call_stack[0];
		// With @throw we can now be skipping some call stack frames, so use the old locals length rather than this function's local count
		this.l = this.l.slice( this.l.length - call_stack[5] );
		this.s.length = call_stack[3];

		// Store the result if there is one
		if ( storer >= 0 )
		{
			this.variable( storer, result | 0 );
		}
	},

	// pc is the address of the storer operand (or branch in v3)
	save: function( pc )
	{
		var memory = this.m,
		stack = this.s,
		locals = this.l,
		quetzal = new file.Quetzal(),
		compressed_mem = [],
		i, j,
		abyte,
		zeroes = 0,
		call_stack = this.call_stack.reverse(),
		frame,
		stack_len,
		stacks = [ 0, 0, 0, 0, 0, 0 ]; // Dummy call frame

		// IFhd chunk
		quetzal.release = memory.getBuffer8( 0x02, 2 );
		quetzal.serial = memory.getBuffer8( 0x12, 6 );
		quetzal.checksum = memory.getBuffer8( 0x1C, 2 );
		quetzal.pc = pc;

		// Memory chunk
		quetzal.compressed = 1;
		for ( i = 0; i < this.staticmem; i++ )
		{
			abyte = memory.getUint8( i ) ^ this.data[i];
			if ( abyte === 0 )
			{
				if ( ++zeroes === 256 )
				{
					compressed_mem.push( 0, 255 );
					zeroes = 0;
				}
			}
			else
			{
				if ( zeroes )
				{
					compressed_mem.push( 0, zeroes - 1 );
					zeroes = 0;
				}
				compressed_mem.push( abyte );
			}
		}
		quetzal.memory = compressed_mem;

		// Stacks
		// Finish the dummy call frame
		stacks.push( call_stack[0][3] >> 8, call_stack[0][3] & 0xFF );
		for ( j = 0; j < call_stack[0][3]; j++ )
		{
			stacks.push( stack[j] >> 8, stack[j] & 0xFF );
		}
		for ( i = 0; i < call_stack.length; i++ )
		{
			frame = call_stack[i];
			stack_len = ( call_stack[i + 1] ? call_stack[i + 1][3] : stack.length ) - frame[3];
			stacks.push(
				frame[0] >> 16, frame[0] >> 8 & 0xFF, frame[0] & 0xFF, // pc
				frame[2] | ( frame[1] < 0 ? 0x10 : 0 ), // locals count and flag for no storer
				frame[1] < 0 ? 0 : frame[1], // storer
				( 1 << frame[4] ) - 1, // provided args
				stack_len >> 8, stack_len & 0xFF // this frame's stack length
			);
			// Locals
			for ( j = locals.length - frame[5] - frame[2]; j < locals.length - frame[5]; j++ )
			{
				stacks.push( locals[j] >> 8, locals[j] & 0xFF );
			}
			// The stack
			for ( j = frame[3]; j < frame[3] + stack_len; j++ )
			{
				stacks.push( stack[j] >> 8, stack[j] & 0xFF );
			}
		}
		call_stack.reverse();
		quetzal.stacks = stacks;

		// Set up the callback function
		this.save_restore_pc = pc;

		// Send the event
		this.act( 'save', {
			data: quetzal.write(),
		} );
	},

	save_restore_result: function( success )
	{
		var memory = this.m,
		pc = this.save_restore_pc,
		temp, iftrue, offset;

		if ( this.version3 )
		{
			// Calculate the branch
			temp = memory.getUint8( pc++ );
			iftrue = temp & 0x80;
			offset = temp & 0x40 ?
				// single byte address
				temp & 0x3F :
				// word address, but first get the second byte of it
				( temp << 8 | memory.getUint8( pc++ ) ) << 18 >> 18;

			if ( !success === !iftrue )
			{
				if ( offset === 0 || offset === 1 )
				{
					this.ret( offset );
				}
				else
				{
					this.pc = offset + pc - 2;
				}
			}
			else
			{
				this.pc = pc;
			}
		}
		else
		{
			this.variable( memory.getUint8( pc++ ), success );
			this.pc = pc;
		}
	},

	save_undo: function( pc, variable )
	{
		this.undo.push( [
			pc,
			variable,
			this.m.getBuffer8( 0, this.staticmem ),
			this.l.slice(),
			this.s.slice(),
			this.call_stack.slice(),
		] );
		return 1;
	},

	scan_table: function( key, addr, length, form )
	{
		form = form || 0x82;
		var memoryfunc = form & 0x80 ? 'getUint16' : 'getUint8';
		form &= 0x7F;
		length = addr + length * form;

		while ( addr < length )
		{
			if ( this.m[memoryfunc]( addr ) === key )
			{
				return addr;
			}
			addr += form;
		}
		return 0;
	},

	set_attr: function( object, attribute )
	{
		var addr = this.objects + ( this.version3 ? 9 : 14 ) * object + ( attribute / 8 ) | 0;
		this.m.setUint8( addr, this.m.getUint8( addr ) | 0x80 >> attribute % 8 );
	},

	set_family: function( obj, newparent, parent, child, bigsis, lilsis )
	{
		var memory = this.m,
		objects = this.objects;

		if ( this.version3 )
		{
			// Set the new parent of the obj
			memory.setUint8( objects + 9 * obj + 4, newparent );
			// Update the parent's first child if needed
			if ( parent )
			{
				memory.setUint8( objects + 9 * parent + 6, child );
			}
			// Update the little sister of a big sister
			if ( bigsis )
			{
				memory.setUint8( objects + 9 * bigsis + 5, lilsis );
			}
		}
		else
		{
			// Set the new parent of the obj
			memory.setUint16( objects + 14 * obj + 6, newparent );
			// Update the parent's first child if needed
			if ( parent )
			{
				memory.setUint16( objects + 14 * parent + 10, child );
			}
			// Update the little sister of a big sister
			if ( bigsis )
			{
				memory.setUint16( objects + 14 * bigsis + 8, lilsis );
			}
		}
	},

	test: function( bitmap, flag )
	{
		return bitmap & flag === flag;
	},

	test_attr: function( object, attribute )
	{
		return ( this.m.getUint8( this.objects + ( this.version3 ? 9 : 14 ) * object + ( attribute / 8 ) | 0 ) << attribute % 8 ) & 0x80;
	},

	// Update the header after restarting or restoring
	update_header: function()
	{
		var memory = this.m,
		width = new this.glk.RefBox();

		// Reset the Xorshift seed
		this.xorshift_seed = 0;

		// For version 3 we only set Flags 1
		if ( this.version3 )
		{
			// Flags 1: Set bits 5, 6
			// TODO: Can we tell from env if the font is fixed pitch?
			return memory.setUint8( 0x01, memory.getUint8( 0x01 ) | 0x60 );
		}

		// Get the window width
		this.glk.glk_window_get_size( this.ui.windows[0], width );
		width = width.get_value();
		
		// Flags 1: Set bits (0), 2, 3, 4: typographic styles are OK
		// Set bit 7 only if timed input is supported
		memory.setUint8( 0x01, 0x1C | ( this.env.timed ? 0x80 : 0 ) );
		// Flags 2: Clear bits 3, 5, 7: no character graphics, mouse or sound effects
		// This is really a word, but we only care about the lower byte
		memory.setUint8( 0x11, memory.getUint8( 0x11 ) & 0x57 );
		// Screen settings
		memory.setUint8( 0x20, 255 ); // Infinite height
		memory.setUint8( 0x21, width );
		memory.setUint16( 0x22, width );
		memory.setUint16( 0x24, 255 );
		memory.setUint16( 0x26, 0x0101 ); // Font height/width in "units"
		// Z Machine Spec revision
		memory.setUint16( 0x32, 0x0102 );
		// Clear flags three, we don't support any of that stuff
		this.extension_table( 4, 0 );

		//TODO: this.ui.update_header();
	},

	// Read or write a variable
	variable: function( variable, value )
	{
		var havevalue = value !== undefined,
		offset;
		if ( variable === 0 )
		{
			if ( havevalue )
			{
				this.s.push( value );
			}
			else
			{
				return this.s.pop();
			}
		}
		else if ( --variable < 15 )
		{
			if ( havevalue )
			{
				this.l[variable] = value;
			}
			else
			{
				return this.l[variable];
			}
		}
		else
		{
			offset = this.globals + ( variable - 15 ) * 2;
			if ( havevalue )
			{
				this.m.setUint16( offset, value );
			}
			else
			{
				return this.m.getUint16( offset );
			}
		}
		return value;
	},

	warn: function()
	{
		if ( this.env.debug && typeof console !== 'undefined' && console.warn )
		{
			console.warn.apply( console, arguments );
		}
	},

	// Utilities for signed arithmetic
	U2S: U2S,
	S2U: S2U,

};

},{"../common/file.js":2,"../common/utils.js":3,"./opcodes.js":7}],9:[function(require,module,exports){
/*

Z-Machine text functions
========================

Copyright (c) 2016 The ifvms.js team
BSD licenced
http://github.com/curiousdannii/ifvms.js

*/

/*

TODO:
	Consider quote suggestions from 1.1 spec

*/

// Key codes accepted by the Z-Machine
var ZSCII_keyCodes = {
	8: 8, // delete/backspace
	13: 13, // enter
	27: 27, // escape
	37: 131, // arrow keys
	38: 129,
	39: 132,
	40: 130,
},
i = 96;
while ( i < 106 )
{
	ZSCII_keyCodes[i] = 49 + i++; // keypad
}
i = 112;
while ( i < 124 )
{
	ZSCII_keyCodes[i] = 21 + i++; // function keys
}

module.exports = {

	init_text: function()
	{
		var self = this,
		memory = this.m,

		alphabet_addr = !this.version3 && memory.getUint16( 0x34 ),
		unicode_addr = this.extension_table( 3 ),
		unicode_len = unicode_addr && memory.getUint8( unicode_addr++ );

		this.abbr_addr = memory.getUint16( 0x18 );

		// Generate alphabets
		function make_alphabet( data )
		{
			var alphabets = [[], [], []],
			i = 0;
			while ( i < 78 )
			{
				alphabets[( i / 26 ) | 0][i % 26] = data[ i++ ];
			}
			// A2->7 is always a newline
			alphabets[2][1] = 13;
			self.alphabets = alphabets;
		}

		// Make the unicode tables
		function make_unicode( data )
		{
			var table = { 13: '\r' }, // New line conversion
			reverse = { 13: 13 },
			i = 0;
			while ( i < data.length )
			{
				table[155 + i] = String.fromCharCode( data[i] );
				reverse[data[i]] = 155 + i++;
			}
			i = 32;
			while ( i < 127 )
			{
				table[i] = String.fromCharCode( i );
				reverse[i] = i++;
			}
			self.unicode_table = table;
			self.reverse_unicode_table = reverse;
		}

		// Check for custom alphabets
		make_alphabet( alphabet_addr ? memory.getBuffer8( alphabet_addr, 78 )
			// Or use the standard alphabet
			: this.text_to_zscii( 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ \r0123456789.,!?_#\'"/\\-:()', 1 ) );

		// Check for a custom unicode table
		make_unicode( unicode_addr ? memory.getBuffer16( unicode_addr, unicode_len )
			// Or use the default
			: this.text_to_zscii( unescape( '%E4%F6%FC%C4%D6%DC%DF%BB%AB%EB%EF%FF%CB%CF%E1%E9%ED%F3%FA%FD%C1%C9%CD%D3%DA%DD%E0%E8%EC%F2%F9%C0%C8%CC%D2%D9%E2%EA%EE%F4%FB%C2%CA%CE%D4%DB%E5%C5%F8%D8%E3%F1%F5%C3%D1%D5%E6%C6%E7%C7%FE%F0%DE%D0%A3%u0153%u0152%A1%BF' ), 1 ) );

		// Parse the standard dictionary
		this.dictionaries = {};
		this.dict = memory.getUint16( 0x08 );
		this.parse_dict( this.dict );

		// Optimise our own functions
		/*if ( DEBUG )
		{
			if ( !debugflags.nooptimise )
			optimise_obj( this, 'TEXT' );
		}*/
	},

	// Decode Z-chars into ZSCII and then Unicode
	decode: function( addr, length )
	{
		var memory = this.m,

		start_addr = addr,
		temp,
		buffer = [],
		i = 0,
		zchar,
		alphabet = 0,
		result = [],
		resulttexts = [],
		usesabbr,
		tenbit,
		unicodecount = 0;

		// Check if this one's been cached already
		if ( this.jit[addr] )
		{
			return this.jit[addr];
		}

		// If we've been given a length, then use it as the finaladdr,
		// Otherwise don't go past the end of the file
		length = length ? length + addr : this.eof;

		// Go through until we've reached the end of the text or a stop bit
		while ( addr < length )
		{
			temp = memory.getUint16( addr );
			addr += 2;

			buffer.push( temp >> 10 & 0x1F, temp >> 5 & 0x1F, temp & 0x1F );

			// Stop bit
			if ( temp & 0x8000 )
			{
				break;
			}
		}

		// Process the Z-chars
		while ( i < buffer.length )
		{
			zchar = buffer[i++];

			// Special chars
			// Space
			if ( zchar === 0 )
			{
				result.push( 32 );
			}
			// Abbreviations
			else if ( zchar < 4 )
			{
				usesabbr = 1;
				result.push( -1 );
				resulttexts.push( '\uE000+this.abbr(' + ( 32 * ( zchar - 1 ) + buffer[i++] ) + ')+\uE000' );
			}
			// Shift characters
			else if ( zchar < 6 )
			{
				alphabet = zchar;
			}
			// Check for a 10 bit ZSCII character
			else if ( alphabet === 2 && zchar === 6 )
			{
				// Check we have enough Z-chars left.
				if ( i + 1 < buffer.length )
				{
					tenbit = buffer[i++] << 5 | buffer[i++];
					// A regular character
					if ( tenbit < 768 )
					{
						result.push( tenbit );
					}
					// 1.1 spec Unicode strings - not the most efficient code, but then noone uses this
					else
					{
						tenbit -= 767;
						unicodecount += tenbit;
						temp = i;
						i = ( i % 3 ) + 3;
						while ( tenbit-- )
						{
							result.push( -1 );
							resulttexts.push( String.fromCharCode( buffer[i] << 10 | buffer[i + 1] << 5 | buffer[i + 2] ) );
							// Set those characters so they won't be decoded again
							buffer[i++] = buffer[i++] = buffer[i++] = 0x20;
						}
						i = temp;
					}
				}
			}
			// Regular characters
			else if ( zchar < 0x20 )
			{
				result.push( this.alphabets[alphabet][ zchar - 6 ] );
			}

			// Reset the alphabet
			alphabet = alphabet < 4 ? 0 : alphabet - 3;

			// Add to the index if we've had raw unicode
			if ( ( i % 3 ) === 0 )
			{
				i += unicodecount;
				unicodecount = 0;
			}
		}

		result = this.zscii_to_text( result, resulttexts );
		// Abbreviations must be extracted at run time, so return a function instead
		if ( usesabbr )
		{
			result = {
				toString: ( Function( 'return"' + result.replace( /\\/g, '\\\\' ).replace( /"/g, '\\"' ).replace( /\r/g, '\\r' ).replace( /\uE000/g, '"' ) + '"' ) ).bind( this ),
			};
		}
		// Cache and return
		if ( start_addr >= this.staticmem )
		{
			this.jit[start_addr] = result;
		}
		return result;
	},

	// Encode ZSCII into Z-chars
	encode: function( zscii )
	{
		var alphabets = this.alphabets,
		zchars = [],
		word_len = this.version3 ? 6 : 9,
		i = 0,
		achar,
		temp,
		result = [];

		// Encode the Z-chars
		while ( zchars.length < word_len )
		{
			achar = zscii[i++];
			// Space
			if ( achar === 32 )
			{
				zchars.push( 0 );
			}
			// Alphabets
			else if ( ( temp = alphabets[0].indexOf( achar ) ) >= 0 )
			{
				zchars.push( temp + 6 );
			}
			else if ( ( temp = alphabets[1].indexOf( achar ) ) >= 0 )
			{
				zchars.push( 4, temp + 6 );
			}
			else if ( ( temp = alphabets[2].indexOf( achar ) ) >= 0 )
			{
				zchars.push( 5, temp + 6 );
			}
			// 10-bit ZSCII / Unicode table
			else if ( ( temp = this.reverse_unicode_table[achar] ) )
			{
				zchars.push( 5, 6, temp >> 5, temp & 0x1F );
			}
			// Pad character
			else if ( achar === undefined )
			{
				zchars.push( 5 );
			}
		}
		zchars.length = word_len;

		// Encode to bytes
		i = 0;
		while ( i < word_len )
		{
			result.push( zchars[i++] << 2 | zchars[i] >> 3, ( zchars[i++] & 0x07 ) << 5 | zchars[i++] );
		}
		result[ result.length - 2 ] |= 0x80;
		return result;
	},

	// In these two functions zscii means an array of ZSCII codes and text means a regular Javascript unicode string
	zscii_to_text: function( zscii, texts )
	{
		var i = 0, l = zscii.length,
		charr,
		j = 0,
		result = '';

		while ( i < l )
		{
			charr = zscii[i++];
			// Text substitution from abbreviations or 1.1 unicode
			if ( charr === -1 )
			{
				result += texts[j++];
			}
			// Regular characters
			if ( ( charr = this.unicode_table[charr] ) )
			{
				result += charr;
			}
		}
		return result;
	},

	// If the second argument is set then don't use the unicode table
	text_to_zscii: function( text, notable )
	{
		var array = [], i = 0, l = text.length, charr;
		while ( i < l )
		{
			charr = text.charCodeAt( i++ );
			// Check the unicode table
			if ( !notable )
			{
				charr = this.reverse_unicode_table[charr] || 63;
			}
			array.push( charr );
		}
		return array;
	},

	// Parse and cache a dictionary
	parse_dict: function( addr )
	{
		var memory = this.m,

		addr_start = addr,
		dict = {},
		entry_len,
		endaddr,

		// Get the word separators
		seperators_len = memory.getUint8( addr++ );

		// Support: IE, Safari, Firefox<38, Chrome<45, Opera<32, Node<4
		// These browsers don't support Uint8Array.indexOf() so convert to a normal array
		dict.separators = Array.prototype.slice.call( memory.getBuffer8( addr, seperators_len ) );

		addr += seperators_len;

		// Go through the dictionary and cache its entries
		entry_len = memory.getUint8( addr++ );
		endaddr = addr + 2 + entry_len * memory.getUint16( addr );
		addr += 2;
		while ( addr < endaddr )
		{
			dict[ Array.prototype.toString.call( memory.getBuffer8( addr, this.version3 ? 4 : 6 ) ) ] = addr;
			addr += entry_len;
		}
		this.dictionaries[addr_start] = dict;

		return dict;
	},

	// Print an abbreviation
	abbr: function( abbrnum )
	{
		return this.decode( this.m.getUint16( this.abbr_addr + 2 * abbrnum ) * 2 );
	},

	// Tokenise a text
	tokenise: function( text, buffer, dictionary, flag )
	{
		// Use the default dictionary if one wasn't provided
		dictionary = dictionary || this.dict;

		// Parse the dictionary if needed
		dictionary = this.dictionaries[dictionary] || this.parse_dict( dictionary );

		var memory = this.m,
		bufferlength = 1e3,
		i = 1,
		letter,
		separators = dictionary.separators,
		word,
		words = [],
		max_words,
		dictword,
		wordcount = 0;

		// In versions 5 and 8 we can get the actual buffer length
		if ( !this.version3 )
		{
			bufferlength = memory.getUint8( text + i++ ) + 2;
		}

		// Find the words, separated by the separators, but as well as the separators themselves
		while ( i < bufferlength )
		{
			letter = memory.getUint8( text + i );
			if ( letter === 0 )
			{
				break;
			}
			else if ( letter === 32 || separators.indexOf( letter ) >= 0 )
			{
				if ( letter !== 32 )
				{
					words.push( [ [letter], i ] );
				}
				word = null;
			}
			else
			{
				if ( !word )
				{
					words.push( [ [], i ] );
					word = words[ words.length - 1 ][0];
				}
				word.push( letter );
			}
			i++;
		}

		// Go through the text until we either have reached the max number of words, or we're out of words
		max_words = Math.min( words.length, memory.getUint8( buffer ) );
		while ( wordcount < max_words )
		{
			dictword = dictionary['' + this.encode( words[wordcount][0] )];

			// If the flag is set then don't overwrite words which weren't found
			if ( !flag || dictword )
			{
				// Fill out the buffer
				memory.setUint16( buffer + 2 + wordcount * 4, dictword || 0 );
				memory.setUint8( buffer + 4 + wordcount * 4, words[wordcount][0].length );
				memory.setUint8( buffer + 5 + wordcount * 4, words[wordcount][1] );
			}
			wordcount++;
		}

		// Update the number of found words
		memory.setUint8( buffer + 1, wordcount );
	},

	// Handle key input
	keyinput: function( data )
	{
		// Handle key codes first, then check the character table, or return a '?' if nothing is found
		return ZSCII_keyCodes[ data.keyCode ] || this.reverse_unicode_table[ data.charCode ] || 63;
	},

};

},{}]},{},[4])(4)
});