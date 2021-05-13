import { Change, ChangeType, Item, Uuid } from '../db';
import { md5 } from '../utils/crypto';
import { ErrorResyncRequired } from '../utils/errors';
import BaseModel, { SaveOptions } from './BaseModel';
import { PaginatedResults } from './utils/pagination';

export interface ChangeWithItem {
	item: Item;
	updated_time: number;
	type: ChangeType;
}

export interface PaginatedChanges extends PaginatedResults {
	items: Change[];
}

export interface ChangePagination {
	limit?: number;
	cursor?: string;
}

export interface ChangePreviousItem {
	name: string;
	jop_parent_id: string;
	jop_resource_ids: string[];
	jop_share_id: string;
}

export function defaultChangePagination(): ChangePagination {
	return {
		limit: 100,
		cursor: '',
	};
}

interface AllForUserOptions {
	compressChanges?: boolean;
}

export default class ChangeModel extends BaseModel<Change> {

	public get tableName(): string {
		return 'changes';
	}

	protected hasUuid(): boolean {
		return true;
	}

	public serializePreviousItem(item: ChangePreviousItem): string {
		return JSON.stringify(item);
	}

	public unserializePreviousItem(item: string): ChangePreviousItem {
		if (!item) return null;
		return JSON.parse(item);
	}

	public changeUrl(): string {
		return `${this.baseUrl}/changes`;
	}

	public async allFromId(id: string): Promise<Change[]> {
		const startChange: Change = id ? await this.load(id) : null;
		const query = this.db(this.tableName).select(...this.defaultFields);
		if (startChange) void query.where('counter', '>', startChange.counter);
		void query.limit(1000);
		let results = await query;
		results = await this.removeDeletedItems(results);
		results = await this.compressChanges(results);
		return results;
	}

	public async allForUser(userId: Uuid, pagination: ChangePagination = null, options: AllForUserOptions = null): Promise<PaginatedChanges> {
		options = {
			compressChanges: true,
			...options,
		};

		pagination = {
			...defaultChangePagination(),
			...pagination,
		};

		let changeAtCursor: Change = null;

		if (pagination.cursor) {
			changeAtCursor = await this.load(pagination.cursor) as Change;
			if (!changeAtCursor) throw new ErrorResyncRequired();
		}

		// When need to get:
		//
		// - All the CREATE and DELETE changes associated with the user
		// - All the UPDATE changes that applies to items associated with the
		//   user.
		//
		// UPDATE changes do not have the user_id set because they are specific
		// to the item, not to a particular user.

		const query = this
			.db('changes')
			.select([
				'id',
				'item_id',
				'item_name',
				'type',
				'updated_time',
			])
			.where(function() {
				void this.whereRaw('((type = ? OR type = ?) AND user_id = ?)', [ChangeType.Create, ChangeType.Delete, userId])
					// Need to use a RAW query here because Knex has a "not a
					// bug" bug that makes it go into infinite loop in some
					// contexts, possibly only when running inside Jest (didn't
					// test outside).
					// https://github.com/knex/knex/issues/1851
					.orWhereRaw('type = ? AND item_id IN (SELECT item_id FROM user_items WHERE user_id = ?)', [ChangeType.Update, userId]);
			});

		console.info('QQQQQQQQQQQQ', (query).toString());

		// If a cursor was provided, apply it to both queries.
		if (changeAtCursor) {
			void query.where('counter', '>', changeAtCursor.counter);
		}

		void query
			.orderBy('counter', 'asc')
			.limit(pagination.limit) as any[];

		const changes = await query;

		const finalChanges = options.compressChanges ? await this.removeDeletedItems(this.compressChanges(changes)) : changes;

		return {
			items: finalChanges,
			// If we have changes, we return the ID of the latest changes from which delta sync can resume.
			// If there's no change, we return the previous cursor.
			cursor: changes.length ? changes[changes.length - 1].id : pagination.cursor,
			has_more: changes.length >= pagination.limit,
		};
	}

	private async removeDeletedItems(changes: Change[]): Promise<Change[]> {
		const itemIds = changes.map(c => c.item_id);

		// We skip permission check here because, when an item is shared, we need
		// to fetch files that don't belong to the current user. This check
		// would not be needed anyway because the change items are generated in
		// a context where permissions have already been checked.
		const items: Item[] = await this.db('items').select('id').whereIn('items.id', itemIds);

		const output: Change[] = [];

		for (const change of changes) {
			const item = items.find(f => f.id === change.item_id);

			// If the item associated with this change has been deleted, we have
			// two cases:
			// - If it's a "delete" change, add it to the list.
			// - If it's anything else, skip it. The "delete" change will be
			//   sent on one of the next pages.

			if (!item && change.type !== ChangeType.Delete) {
				continue;
			}

			output.push(change);
		}

		return output;
	}

	// Compresses the changes so that, for example, multiple updates on the same
	// item are reduced down to one, because calling code usually only needs to
	// know that the item has changed at least once. The reduction is basically:
	//
	//     create - update => create
	//     create - delete => NOOP
	//     update - update => update
	//     update - delete => delete
	//
	// There's one exception for changes that include a "previous_item". This is
	// used to save specific properties about the previous state of the item,
	// such as "jop_parent_id" or "name", which is used by the share mechanism
	// to know if an item has been moved from one folder to another. In that
	// case, we need to know about each individual change, so they are not
	// compressed.
	private compressChanges(changes: Change[]): Change[] {
		const itemChanges: Record<Uuid, Change> = {};

		const uniqueUpdateChanges: Record<Uuid, Record<string, Change>> = {};

		for (const change of changes) {
			const itemId = change.item_id;
			const previous = itemChanges[itemId];

			if (change.type === ChangeType.Update) {
				const key = md5(itemId + change.previous_item);
				if (!uniqueUpdateChanges[itemId]) uniqueUpdateChanges[itemId] = {};
				uniqueUpdateChanges[itemId][key] = change;
			}

			if (previous) {
				if (previous.type === ChangeType.Create && change.type === ChangeType.Update) {
					continue;
				}

				if (previous.type === ChangeType.Create && change.type === ChangeType.Delete) {
					delete itemChanges[itemId];
				}

				if (previous.type === ChangeType.Update && change.type === ChangeType.Update) {
					itemChanges[itemId] = change;
				}

				if (previous.type === ChangeType.Update && change.type === ChangeType.Delete) {
					itemChanges[itemId] = change;
				}
			} else {
				itemChanges[itemId] = change;
			}
		}

		const output: Change[] = [];

		for (const itemId in itemChanges) {
			const change = itemChanges[itemId];
			if (change.type === ChangeType.Update) {
				for (const key of Object.keys(uniqueUpdateChanges[itemId])) {
					output.push(uniqueUpdateChanges[itemId][key]);
				}
			} else {
				output.push(change);
			}
		}

		output.sort((a: Change, b: Change) => a.counter < b.counter ? -1 : +1);

		return output;
	}

	public async save(change: Change, options: SaveOptions = {}): Promise<Change> {
		const savedChange = await super.save(change, options);
		ChangeModel.eventEmitter.emit('saved');
		return savedChange;
	}

}
